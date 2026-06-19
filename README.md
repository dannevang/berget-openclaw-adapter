# berget-adapter

A tiny, zero-dependency loopback proxy that makes **[Berget AI](https://berget.ai)**'s
OpenAI-compatible API accept the tool / function-calling schemas that
**[OpenClaw](https://openclaw.ai)** (and other strict OpenAI clients) emit.

Berget is an EU-sovereign (Sweden) inference provider — a good fit when you need
GDPR-friendly, data-resident LLMs. Its `/v1` endpoint is OpenAI-compatible, but its
request validator is stricter than the spec in one spot, which breaks tool calling
out of the box. This ~70-line proxy fixes that.

## The problem

Berget's `/v1` validator rejects JSON-Schema `type` fields written as a
union / nullable array:

```jsonc
{ "type": ["string", "null"] }   // valid per JSON Schema + OpenAI, rejected by Berget
```

OpenClaw emits exactly this shape for **optional** tool parameters. The result is an
HTTP `400` upstream — the tool call dies before the model ever runs.

## The fix

The proxy recursively walks the outgoing request body and collapses every
array-valued `type` to its single non-null member:

```jsonc
{ "type": ["string", "null"] }  ->  { "type": "string" }
```

Everything else is forwarded byte-for-byte. You point your OpenClaw provider's
`baseUrl` at this proxy instead of `https://api.berget.ai/v1`, and tool calling
just works.

## Requirements

- **Node.js ≥ 18** (stdlib only — no `npm install` needed)
- A **Berget AI API key** (`https://berget.ai`)

## Quick start

```bash
git clone <this-repo>
cd berget-adapter
node berget-adapter.js
# -> berget-adapter up 127.0.0.1:8899 -> api.berget.ai
```

Leave it running, then point OpenClaw at `http://127.0.0.1:8899/v1` (see below).

### Configuration (all optional, via environment)

| Variable | Default | Purpose |
|---|---|---|
| `BERGET_ADAPTER_PORT` | `8899` | Listen port |
| `BERGET_ADAPTER_HOST` | `127.0.0.1` | Listen address (keep it loopback) |
| `BERGET_UPSTREAM` | `api.berget.ai` | Upstream host |
| `BERGET_ADAPTER_LOG` | _stderr_ | Log file path; only error status codes are logged |

## Using it with OpenClaw

Add a provider whose `baseUrl` is the proxy, and pass your key via an env var. See
[`examples/openclaw.config.json5`](examples/openclaw.config.json5) for a complete,
copy-pasteable block. The essentials:

```jsonc
{
  models: {
    mode: "merge",
    providers: {
      berget: {
        baseUrl: "http://127.0.0.1:8899/v1",   // <- the proxy, not api.berget.ai
        apiKey: "${BERGET_AI_API}",             // <- exported in your environment
        api: "openai-completions",
        request: { allowPrivateNetwork: true }, // loopback baseUrl needs this
        models: [
          { id: "google/gemma-4-31B-it", name: "Gemma 4 31B (Berget / EU)",
            reasoning: false, input: ["text", "image"],
            contextWindow: 262144, maxTokens: 8192 },
          { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6 (Berget / EU)",
            reasoning: true, input: ["text", "image"],
            contextWindow: 262144, maxTokens: 32768 }
        ]
      }
    }
  },
  agents: { defaults: { model: { primary: "berget/google/gemma-4-31B-it" } } }
}
```

> **`allowPrivateNetwork: true`** is required because the `baseUrl` is a loopback
> address — OpenClaw blocks private-network requests by default.

Export your key before starting OpenClaw (or resolve it from your secret manager):

```bash
export BERGET_AI_API="sk-..."   # your Berget key
```

## Running it as a service

So the proxy comes back after a reboot:

- **macOS (launchd):** [`examples/com.berget-adapter.plist`](examples/com.berget-adapter.plist)
- **Linux (systemd):** [`examples/berget-adapter.service`](examples/berget-adapter.service)

Both are templates — replace the placeholder paths / user, then install per the
comments inside.

## Security & privacy

- **Loopback only.** Binds to `127.0.0.1`; nothing is exposed off-host.
- **No credentials stored.** Your `Authorization: Bearer <key>` header is forwarded
  verbatim from OpenClaw to Berget — the proxy never reads, rewrites, or persists it.
- **No body logging.** Only upstream error status codes are ever logged.

## How it works (the whole thing)

It's intentionally small enough to audit in one sitting: an `http` server on
loopback parses each JSON body, runs `fixTypes()` over it, and re-streams the
request to Berget over `https`, piping the response straight back. Non-JSON bodies
(like `GET /v1/models`) pass through untouched. See
[`berget-adapter.js`](berget-adapter.js).

## License

MIT — see [LICENSE](LICENSE).
