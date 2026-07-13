import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_API, loadConfigFromEnv } from "./config.ts";
import { streamOpenAICompatible } from "./stream.ts";

/**
 * Pi coding-agent extension: registers a URL + API-key OpenAI-compatible text
 * provider whose protocol handling is delegated to `@ai-sdk/openai-compatible`.
 *
 * Configure it with environment variables (see `config.ts` / README) — at
 * minimum `PI_TEXT_BASE_URL`, `PI_TEXT_API_KEY`, and `PI_TEXT_MODELS`. When it
 * is not configured the extension registers nothing and stays out of the way.
 */
export default function (pi: ExtensionAPI): void {
	const config = loadConfigFromEnv(process.env);
	if (!config) return;

	pi.registerProvider(config.providerId, {
		name: config.name,
		baseUrl: config.baseUrl,
		apiKey: config.apiKeyRef,
		api: PROVIDER_API,
		headers: config.headers,
		models: config.models,
		streamSimple: streamOpenAICompatible,
	});
}
