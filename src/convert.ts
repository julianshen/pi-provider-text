import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import type {
	AssistantMessage,
	Context,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

/**
 * Convert a Pi conversation `Context` into the AI SDK message format consumed
 * by `streamText`. The system prompt is passed separately (see `stream.ts`).
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				out.push(fromUser(message));
				break;
			case "assistant":
				out.push(fromAssistant(message));
				break;
			case "toolResult":
				out.push(fromToolResult(message));
				break;
		}
	}
	return out;
}

function fromUser(message: UserMessage): ModelMessage {
	if (typeof message.content === "string") {
		return { role: "user", content: message.content };
	}
	const parts: Extract<ModelMessage, { role: "user" }>["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			// Pi stores images as base64; the AI SDK accepts a base64 string plus mediaType.
			parts.push({ type: "image", image: block.data, mediaType: block.mimeType });
		}
	}
	return { role: "user", content: parts.length > 0 ? parts : "" };
}

function fromAssistant(message: AssistantMessage): ModelMessage {
	const parts: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text) parts.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			parts.push({
				type: "tool-call",
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments ?? {},
			});
		}
		// Thinking blocks are intentionally dropped: OpenAI-compatible chat
		// endpoints do not accept prior reasoning content as input.
	}
	return { role: "assistant", content: parts.length > 0 ? parts : "" };
}

function fromToolResult(message: ToolResultMessage): ModelMessage {
	const text = message.content
		.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const hasImage = message.content.some((c) => c.type === "image");
	const value = text || (hasImage ? "[non-text tool result omitted]" : "");
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				output: message.isError
					? { type: "error-text", value }
					: { type: "text", value },
			},
		],
	};
}

/**
 * Convert Pi tool definitions into an AI SDK `ToolSet`. The tools are declared
 * without an `execute` function so `streamText` surfaces each `tool-call` and
 * stops the step — Pi's agent loop runs the tools and feeds results back.
 */
export function toToolSet(tools: Context["tools"]): ToolSet | undefined {
	if (!tools || tools.length === 0) return undefined;
	const set: ToolSet = {};
	for (const t of tools) {
		set[t.name] = tool({
			description: t.description,
			// Pi tool `parameters` are typebox schemas, i.e. plain JSON Schema.
			inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
		});
	}
	return set;
}
