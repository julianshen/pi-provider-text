import http from "node:http";
import { streamOpenAICompatible } from "../src/stream.ts";
import { loadConfigFromEnv, PROVIDER_API } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible server
// ---------------------------------------------------------------------------
function sse(lines: object[]): string {
	return lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
}

function makeServer(): Promise<{ url: string; close: () => void; lastBody: () => any }> {
	let lastBody: any;
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			lastBody = raw ? JSON.parse(raw) : undefined;
			const wantsTool = JSON.stringify(lastBody).includes("get_weather");
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const chunks = wantsTool
				? sse([
						{ choices: [{ index: 0, delta: { role: "assistant", content: "Let me check." }, finish_reason: null }] },
						{
							choices: [
								{
									index: 0,
									delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] },
									finish_reason: null,
								},
							],
						},
						{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
						{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: null }] },
						{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 } },
				  ])
				: sse([
						{ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
						{ choices: [{ index: 0, delta: { content: ", world!" }, finish_reason: null }] },
						{
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
						},
				  ]);
			res.end(chunks);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close(), lastBody: () => lastBody });
		});
	});
}

function makeModel(baseUrl: string): any {
	return {
		id: "test-model",
		name: "Test Model",
		api: PROVIDER_API,
		provider: "text",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return events;
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error("ASSERT FAILED: " + msg);
	console.log("  ✓ " + msg);
}

async function main() {
	const { url, close, lastBody } = await makeServer();
	const model = makeModel(url);

	try {
		// --- Test 1: plain text streaming + usage/cost ---
		console.log("\n[Test 1] text streaming");
		const events1 = await collect(
			streamOpenAICompatible(model, {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			}, { apiKey: "sk-test" }),
		);
		const types1 = events1.map((e) => e.type);
		assert(types1[0] === "start", "first event is start");
		assert(types1.includes("text_start") && types1.includes("text_delta") && types1.includes("text_end"), "text lifecycle emitted");
		const done1 = events1.find((e) => e.type === "done");
		assert(!!done1, "done event present");
		assert(done1.reason === "stop", "done reason is stop");
		const text = done1.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		assert(text === "Hello, world!", `assembled text = "${text}"`);
		const u = done1.message.usage;
		assert(u.output === 5, `output tokens = ${u.output}`);
		assert(u.cacheRead === 4, `cacheRead tokens = ${u.cacheRead}`);
		assert(u.input === 6, `input (non-cached) tokens = ${u.input} (10 total - 4 cached)`);
		assert(u.cost.total > 0, `cost computed = ${u.cost.total}`);

		// verify auth header + request payload reached the server
		const body1 = lastBody();
		assert(body1.model === "test-model", "request carried model id");
		assert(Array.isArray(body1.messages) && body1.messages[0].role === "system", "system prompt forwarded");

		// --- Test 2: tool call streaming ---
		console.log("\n[Test 2] tool-call streaming");
		const events2 = await collect(
			streamOpenAICompatible(model, {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "weather in NYC?", timestamp: Date.now() }],
				tools: [
					{
						name: "get_weather",
						description: "Get weather for a city",
						parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } as any,
					},
				],
			}, { apiKey: "sk-test" }),
		);
		const types2 = events2.map((e) => e.type);
		assert(types2.includes("toolcall_start") && types2.includes("toolcall_end"), "toolcall lifecycle emitted");
		const done2 = events2.find((e) => e.type === "done");
		assert(done2.reason === "toolUse", "done reason is toolUse");
		const toolCall = done2.message.content.find((c: any) => c.type === "toolCall");
		assert(!!toolCall, "toolCall block present in message");
		assert(toolCall.name === "get_weather", `tool name = ${toolCall.name}`);
		assert(JSON.stringify(toolCall.arguments) === '{"city":"NYC"}', `tool args = ${JSON.stringify(toolCall.arguments)}`);
		const end2 = events2.find((e) => e.type === "toolcall_end");
		assert(JSON.stringify(end2.toolCall.arguments) === '{"city":"NYC"}', "toolcall_end carries parsed arguments");

		// verify tools were forwarded in the request
		const body2 = lastBody();
		assert(Array.isArray(body2.tools) && body2.tools[0].function.name === "get_weather", "tool definition forwarded to provider");

		// --- Test 3: config parsing ---
		console.log("\n[Test 3] env config parsing");
		const cfg = loadConfigFromEnv({
			PI_TEXT_BASE_URL: "https://api.example.com/v1",
			PI_TEXT_API_KEY: "secret",
			PI_TEXT_MODELS: "qwen2.5-coder:7b, model-b=Model B Pro",
			PI_TEXT_PROVIDER_ID: "mytext",
		});
		assert(cfg !== null, "config parsed");
		assert(cfg!.providerId === "mytext", "provider id honored");
		assert(cfg!.apiKeyRef === "$PI_TEXT_API_KEY", "apiKey reference built");
		assert(cfg!.models.length === 2 && cfg!.models[1].name === "Model B Pro", "models + display names parsed");
		// Regression: colons in the model id (ollama-style tags) must not be split.
		assert(cfg!.models[0].id === "qwen2.5-coder:7b", `colon-in-id preserved (${cfg!.models[0].id})`);
		assert(cfg!.models[0].name === "qwen2.5-coder:7b", "colon-in-id defaults name to full id");
		assert(loadConfigFromEnv({}) === null, "empty env => null (inert)");
		assert(loadConfigFromEnv({ PI_TEXT_MODELS: "x" }) === null, "models without base url => null");

		console.log("\nALL TESTS PASSED ✅");
	} finally {
		close();
	}
}

main().catch((e) => {
	console.error("\n❌ TEST RUN FAILED:", e);
	process.exit(1);
});
