import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * The `api` identifier this extension registers its custom `streamSimple`
 * implementation under. It must be unique across providers; the built-in Pi
 * APIs (`openai-completions`, `anthropic-messages`, ...) are reserved, so we use
 * a dedicated name that routes to the `@ai-sdk/openai-compatible` handler.
 */
export const PROVIDER_API = "openai-compatible-text";

export interface TextProviderConfig {
	providerId: string;
	name: string;
	baseUrl: string;
	/** `$ENV` reference resolved by Pi per-request into `options.apiKey`. */
	apiKeyRef: string;
	headers?: Record<string, string>;
	models: ProviderModelConfig[];
}

type Env = Record<string, string | undefined>;

function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
	const t = trimmed(value)?.toLowerCase();
	if (t === undefined) return fallback;
	return t === "1" || t === "true" || t === "yes" || t === "on";
}

function numberEnv(value: string | undefined, fallback: number): number {
	const t = trimmed(value);
	if (t === undefined) return fallback;
	const n = Number(t);
	return Number.isFinite(n) ? n : fallback;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
	const t = trimmed(raw);
	if (t === undefined) return undefined;
	try {
		const parsed = JSON.parse(t);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (v != null) out[k] = String(v);
			}
			return Object.keys(out).length > 0 ? out : undefined;
		}
	} catch {
		console.warn("[pi-provider-text] PI_TEXT_HEADERS is not valid JSON; ignoring.");
	}
	return undefined;
}

/**
 * Parse a comma-separated model spec. Each entry is `id` or `id=Display Name`.
 *   "gpt-oss-120b, my-model=My Model"
 *
 * `=` (not `:`) separates the id from the display name so that model ids which
 * legitimately contain colons — e.g. Ollama tags like `qwen2.5-coder:7b` — are
 * preserved intact.
 */
function parseModels(raw: string | undefined): { id: string; name: string }[] {
	const t = trimmed(raw);
	if (t === undefined) return [];
	const models: { id: string; name: string }[] = [];
	for (const chunk of t.split(",")) {
		const entry = chunk.trim();
		if (!entry) continue;
		const sep = entry.indexOf("=");
		if (sep > 0) {
			const id = entry.slice(0, sep).trim();
			const name = entry.slice(sep + 1).trim();
			if (id) models.push({ id, name: name || id });
		} else {
			models.push({ id: entry, name: entry });
		}
	}
	return models;
}

/**
 * Build the provider configuration from environment variables. Returns `null`
 * when the extension is not configured (no base URL or no models), so the
 * extension stays inert instead of registering a broken provider.
 *
 * Recognized variables:
 *   PI_TEXT_BASE_URL       (required) OpenAI-compatible base URL, e.g. https://api.example.com/v1
 *   PI_TEXT_API_KEY        (required for authed endpoints) API key; sent as `Authorization: Bearer`
 *   PI_TEXT_MODELS         (required) comma-separated model ids, entries may be `id=Display Name`
 *   PI_TEXT_MODEL          alias for a single model id (used if PI_TEXT_MODELS is unset)
 *   PI_TEXT_API_KEY_ENV    name of the env var holding the key (default: PI_TEXT_API_KEY)
 *   PI_TEXT_PROVIDER_ID    provider key shown in `/model` (default: "text")
 *   PI_TEXT_PROVIDER_NAME  human-readable provider name (default: "Custom Text Provider")
 *   PI_TEXT_CONTEXT_WINDOW context window in tokens (default: 128000)
 *   PI_TEXT_MAX_TOKENS     max output tokens (default: 16384)
 *   PI_TEXT_REASONING      "true" if the models expose reasoning/thinking (default: false)
 *   PI_TEXT_INPUT_IMAGE    "true" if the models accept image input (default: false)
 *   PI_TEXT_HEADERS        JSON object of extra static headers (values may use Pi's $ENV / !cmd syntax)
 *   PI_TEXT_COST_INPUT     input cost per million tokens (default: 0)
 *   PI_TEXT_COST_OUTPUT    output cost per million tokens (default: 0)
 *   PI_TEXT_COST_CACHE_READ  cached-read cost per million tokens (default: 0)
 *   PI_TEXT_COST_CACHE_WRITE cache-write cost per million tokens (default: 0)
 */
export function loadConfigFromEnv(env: Env): TextProviderConfig | null {
	const baseUrl = trimmed(env.PI_TEXT_BASE_URL);
	const models = parseModels(env.PI_TEXT_MODELS ?? env.PI_TEXT_MODEL);

	if (!baseUrl && models.length === 0) {
		// Nothing configured at all: stay silent and inert.
		return null;
	}
	if (!baseUrl) {
		console.warn("[pi-provider-text] PI_TEXT_MODELS is set but PI_TEXT_BASE_URL is missing; provider not registered.");
		return null;
	}
	if (models.length === 0) {
		console.warn("[pi-provider-text] PI_TEXT_BASE_URL is set but no models (PI_TEXT_MODELS/PI_TEXT_MODEL); provider not registered.");
		return null;
	}

	const apiKeyEnvName = trimmed(env.PI_TEXT_API_KEY_ENV) ?? "PI_TEXT_API_KEY";
	const contextWindow = numberEnv(env.PI_TEXT_CONTEXT_WINDOW, 128_000);
	const maxTokens = numberEnv(env.PI_TEXT_MAX_TOKENS, 16_384);
	const reasoning = boolEnv(env.PI_TEXT_REASONING, false);
	const input: ("text" | "image")[] = boolEnv(env.PI_TEXT_INPUT_IMAGE, false)
		? ["text", "image"]
		: ["text"];
	const cost = {
		input: numberEnv(env.PI_TEXT_COST_INPUT, 0),
		output: numberEnv(env.PI_TEXT_COST_OUTPUT, 0),
		cacheRead: numberEnv(env.PI_TEXT_COST_CACHE_READ, 0),
		cacheWrite: numberEnv(env.PI_TEXT_COST_CACHE_WRITE, 0),
	};

	const modelConfigs: ProviderModelConfig[] = models.map(({ id, name }) => ({
		id,
		name,
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
	}));

	return {
		providerId: trimmed(env.PI_TEXT_PROVIDER_ID) ?? "text",
		name: trimmed(env.PI_TEXT_PROVIDER_NAME) ?? "Custom Text Provider",
		baseUrl,
		apiKeyRef: `$${apiKeyEnvName}`,
		headers: parseHeaders(env.PI_TEXT_HEADERS),
		models: modelConfigs,
	};
}
