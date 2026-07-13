# pi-provider-text

A [pi](https://github.com/earendil-works/pi) coding-agent **extension** that registers a
custom, URL + API-key **OpenAI-compatible text provider**. Unlike pi's built-in
`openai-completions` handler, this extension delegates all protocol handling to the
Vercel AI SDK's [`@ai-sdk/openai-compatible`](https://ai-sdk.dev/providers/openai-compatible-providers)
package via a custom `streamSimple` implementation.

Point it at any OpenAI-compatible `/chat/completions` endpoint (self-hosted vLLM,
Ollama, LM Studio, Together, Fireworks, OpenRouter, a corporate gateway, …), give it a
key and a model list, and it shows up in pi's `/model` picker.

## How it works

```
pi agent  ──registerProvider(streamSimple)──▶  streamOpenAICompatible()
                                                     │
                            Pi Context ──convert──▶  @ai-sdk/openai-compatible + streamText
                                                     │
                            Pi events  ◀──translate── AI SDK fullStream parts
```

- `src/index.ts` — extension entry point; reads env config and calls `pi.registerProvider()`.
- `src/config.ts` — builds the provider/model config from environment variables.
- `src/convert.ts` — converts pi's `Context` (messages + tools) into AI SDK format.
- `src/stream.ts` — the custom `streamSimple`: runs `streamText` against
  `@ai-sdk/openai-compatible` and translates the AI SDK `fullStream` back into pi's
  `AssistantMessageEvent` stream (text, thinking, tool calls, usage, cost, stop reason).

The provider's API key is declared as a `$ENV` reference, so pi resolves it per-request
and hands it to `streamSimple`; the extension never reads the raw secret at registration
time.

## Install

This is a dependency-bearing extension, so it needs its `node_modules` installed.

```bash
# Clone into pi's global extensions directory (or a project-local .pi/extensions/)
git clone https://github.com/julianshen/pi-provider-text ~/.pi/agent/extensions/pi-provider-text
cd ~/.pi/agent/extensions/pi-provider-text
npm install
```

pi discovers the extension via the `pi.extensions` field in `package.json`
(`./src/index.ts`). For a quick one-off test without installing globally you can also
run pi with `-e /path/to/pi-provider-text/src/index.ts`.

## Configure

Set environment variables before starting pi (see [`.env.example`](./.env.example)):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PI_TEXT_BASE_URL` | ✅ | — | OpenAI-compatible base URL, usually ending in `/v1`. |
| `PI_TEXT_API_KEY` | ✅¹ | — | API key, sent as `Authorization: Bearer <key>`. |
| `PI_TEXT_MODELS` | ✅ | — | Comma-separated model ids. Each entry may be `id` or `id=Display Name`. Use `=` (not `:`) so ids with colons — e.g. Ollama tags like `qwen2.5-coder:7b` — stay intact. |
| `PI_TEXT_MODEL` | — | — | Single-model alias, used only if `PI_TEXT_MODELS` is unset. |
| `PI_TEXT_API_KEY_ENV` | — | `PI_TEXT_API_KEY` | Name of the env var holding the key. |
| `PI_TEXT_PROVIDER_ID` | — | `text` | Provider key shown in `/model`. |
| `PI_TEXT_PROVIDER_NAME` | — | `Custom Text Provider` | Human-readable provider name. |
| `PI_TEXT_CONTEXT_WINDOW` | — | `128000` | Context window in tokens. |
| `PI_TEXT_MAX_TOKENS` | — | `16384` | Max output tokens. |
| `PI_TEXT_REASONING` | — | `false` | `true` if the models expose reasoning/thinking. |
| `PI_TEXT_INPUT_IMAGE` | — | `false` | `true` if the models accept image input. |
| `PI_TEXT_HEADERS` | — | — | Extra static headers as JSON (values may use pi's `$ENV` / `!cmd` syntax). |
| `PI_TEXT_COST_*` | — | `0` | `INPUT` / `OUTPUT` / `CACHE_READ` / `CACHE_WRITE` cost per million tokens. |

¹ Only required for endpoints that need auth; leave unset for keyless local servers.

If neither a base URL nor any models are configured, the extension registers nothing and
stays inert.

### Example

```bash
export PI_TEXT_BASE_URL="http://localhost:1234/v1"
export PI_TEXT_API_KEY="lm-studio"
export PI_TEXT_MODELS="qwen2.5-coder:7b=Qwen2.5 Coder 7B"
pi
# then: /model  ->  pick "Custom Text Provider"
```

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # runs the streaming/config verification harness against a mock server
```

The test harness (`test/harness.ts`) spins up a mock OpenAI-compatible SSE server and
asserts that text streaming, cached-token/cost accounting, and tool-call streaming are
translated correctly into pi events.

## Notes & limitations

- Uses pi's custom-provider `streamSimple` hook, registered under the `api` identifier
  `openai-compatible-text`.
- Prior assistant **thinking** blocks are dropped when replaying history, since
  OpenAI-compatible chat endpoints don't accept reasoning content as input. New reasoning
  emitted by the model during a turn is streamed through normally (when
  `PI_TEXT_REASONING=true`).
- Non-text tool results (e.g. images) are sent to the model as a short text placeholder.
- Reasoning effort is passed as the provider option `reasoningEffort` when the model is
  marked as reasoning-capable; providers that don't understand it simply ignore it.

## License

MIT — see [LICENSE](./LICENSE).
