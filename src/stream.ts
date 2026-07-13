import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ThinkingLevel,
	type Usage,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { toModelMessages, toToolSet } from "./convert.ts";

/** Minimal structural view of the AI SDK `LanguageModelUsage` we consume. */
interface SdkUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	inputTokenDetails?: {
		noCacheTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
	outputTokenDetails?: { reasoningTokens?: number };
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Map an AI SDK finish reason to the restricted Pi "done" reason. */
function toDoneReason(reason: string | undefined): Extract<StopReason, "stop" | "length" | "toolUse"> {
	if (reason === "tool-calls") return "toolUse";
	if (reason === "length") return "length";
	return "stop";
}

/** OpenAI-style `reasoning_effort` only accepts a few values. */
function toReasoningEffort(model: Model<Api>, level: ThinkingLevel): string | undefined {
	const mapped = model.thinkingLevelMap?.[level];
	if (mapped === null) return undefined; // explicitly disabled for this level
	if (mapped !== undefined) return mapped;
	switch (level) {
		case "minimal":
			return "minimal";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return "high";
		default:
			return undefined;
	}
}

function applyUsage(usage: Usage, u: SdkUsage | undefined): void {
	if (!u) return;
	const inputTotal = u.inputTokens ?? 0;
	const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0;
	const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
	const noCache = u.inputTokenDetails?.noCacheTokens;
	usage.input = noCache ?? Math.max(0, inputTotal - cacheRead - cacheWrite);
	usage.cacheRead = cacheRead;
	usage.cacheWrite = cacheWrite;
	usage.output = u.outputTokens ?? 0;
	const reasoningTokens = u.outputTokenDetails?.reasoningTokens;
	if (reasoningTokens !== undefined) usage.reasoning = reasoningTokens;
	usage.totalTokens =
		u.totalTokens ?? usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function toHeaders(headers: SimpleStreamOptions["headers"]): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (v != null) out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Custom Pi `streamSimple` implementation that delegates protocol handling to
 * `@ai-sdk/openai-compatible`. It converts the Pi `Context` into AI SDK
 * messages/tools, streams via `streamText`, and translates the AI SDK
 * `fullStream` parts back into Pi `AssistantMessageEvent`s.
 */
export function streamOpenAICompatible(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	void (async () => {
		try {
			stream.push({ type: "start", partial: output });

			const provider = createOpenAICompatible({
				name: model.provider,
				baseURL: model.baseUrl,
				apiKey: options?.apiKey,
				headers: toHeaders(options?.headers),
				includeUsage: true,
			});

			let providerOptions: Record<string, Record<string, string>> | undefined;
			if (model.reasoning && options?.reasoning) {
				const effort = toReasoningEffort(model, options.reasoning);
				if (effort) providerOptions = { [model.provider]: { reasoningEffort: effort } };
			}

			const result = streamText({
				model: provider(model.id),
				system: context.systemPrompt,
				messages: toModelMessages(context.messages),
				tools: toToolSet(context.tools),
				abortSignal: options?.signal,
				maxOutputTokens: options?.maxTokens ?? model.maxTokens,
				temperature: options?.temperature,
				providerOptions,
				// We handle errors from the `error` stream part below; suppress the
				// AI SDK's default console logging so failures aren't double-reported.
				onError: () => {},
			});

			// AI SDK stream ids -> index into `output.content`.
			const textIndex = new Map<string, number>();
			const thinkingIndex = new Map<string, number>();
			const toolState = new Map<string, { index: number; streamed: boolean }>();
			let finishReason: string | undefined;
			let aborted = false;

			for await (const part of result.fullStream) {
				switch (part.type) {
					case "text-start": {
						output.content.push({ type: "text", text: "" });
						const index = output.content.length - 1;
						textIndex.set(part.id, index);
						stream.push({ type: "text_start", contentIndex: index, partial: output });
						break;
					}
					case "text-delta": {
						const index = textIndex.get(part.id);
						if (index === undefined) break;
						const block = output.content[index];
						if (block?.type === "text") block.text += part.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: output });
						break;
					}
					case "text-end": {
						const index = textIndex.get(part.id);
						if (index === undefined) break;
						const block = output.content[index];
						const content = block?.type === "text" ? block.text : "";
						stream.push({ type: "text_end", contentIndex: index, content, partial: output });
						textIndex.delete(part.id);
						break;
					}
					case "reasoning-start": {
						output.content.push({ type: "thinking", thinking: "" });
						const index = output.content.length - 1;
						thinkingIndex.set(part.id, index);
						stream.push({ type: "thinking_start", contentIndex: index, partial: output });
						break;
					}
					case "reasoning-delta": {
						const index = thinkingIndex.get(part.id);
						if (index === undefined) break;
						const block = output.content[index];
						if (block?.type === "thinking") block.thinking += part.text;
						stream.push({ type: "thinking_delta", contentIndex: index, delta: part.text, partial: output });
						break;
					}
					case "reasoning-end": {
						const index = thinkingIndex.get(part.id);
						if (index === undefined) break;
						const block = output.content[index];
						const content = block?.type === "thinking" ? block.thinking : "";
						stream.push({ type: "thinking_end", contentIndex: index, content, partial: output });
						thinkingIndex.delete(part.id);
						break;
					}
					case "tool-input-start": {
						output.content.push({ type: "toolCall", id: part.id, name: part.toolName, arguments: {} });
						const index = output.content.length - 1;
						toolState.set(part.id, { index, streamed: false });
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						break;
					}
					case "tool-input-delta": {
						const entry = toolState.get(part.id);
						if (!entry) break;
						entry.streamed = true;
						stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta: part.delta, partial: output });
						break;
					}
					case "tool-call": {
						let entry = toolState.get(part.toolCallId);
						if (!entry) {
							// Provider emitted a tool call without streaming its input.
							output.content.push({ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: {} });
							const index = output.content.length - 1;
							entry = { index, streamed: false };
							toolState.set(part.toolCallId, entry);
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						}
						const input = (part.input ?? {}) as Record<string, unknown>;
						const block = output.content[entry.index];
						if (block?.type === "toolCall") {
							block.id = part.toolCallId;
							block.name = part.toolName;
							block.arguments = input;
						}
						if (!entry.streamed) {
							const json = JSON.stringify(input);
							if (json && json !== "{}") {
								stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta: json, partial: output });
							}
						}
						stream.push({
							type: "toolcall_end",
							contentIndex: entry.index,
							toolCall: { type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: input },
							partial: output,
						});
						toolState.delete(part.toolCallId);
						break;
					}
					case "finish": {
						applyUsage(output.usage, part.totalUsage as SdkUsage);
						finishReason = part.finishReason;
						break;
					}
					case "abort": {
						aborted = true;
						break;
					}
					case "error": {
						throw part.error instanceof Error ? part.error : new Error(String(part.error));
					}
					default:
						break;
				}
			}

			if (aborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.usage.cost = calculateCost(model, output.usage);
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end(output);
				return;
			}

			output.usage.cost = calculateCost(model, output.usage);
			const reason = toDoneReason(finishReason);
			output.stopReason = reason;
			stream.push({ type: "done", reason, message: output });
			stream.end(output);
		} catch (error) {
			const abort = isAbort(error, options?.signal);
			output.stopReason = abort ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			output.usage.cost = calculateCost(model, output.usage);
			stream.push({ type: "error", reason: abort ? "aborted" : "error", error: output });
			stream.end(output);
		}
	})();

	return stream;
}
