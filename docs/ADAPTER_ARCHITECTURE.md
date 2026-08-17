# Provider-neutral surface and adapter architecture

Provider family and working surface are separate concepts. OpenAI can have `chatgpt.web` and `codex.local`; Google can have `gemini.web` and `antigravity.local`. Retrieval produces provider-neutral evidence. A delivery plan maps that evidence onto one registered surface contract.

## Built-in surfaces

| Surface | Family | Channel | Text | Images/PDF/files | Local repository | Context API |
|---|---|---|---:|---:|---:|---:|
| `chatgpt.web` | OpenAI | browser companion | yes | bounded native attachments | no | no |
| `gemini.web` | Google | browser companion | yes | bounded native attachments | no | no |
| `codex.local` | OpenAI | local agent | yes | via scoped context evidence, not companion attachment | registered root only | read-only |
| `antigravity.local` | Google | local agent | yes | via scoped context evidence, not companion attachment | registered root only | read-only |

The registry contract includes adapter version, channel, provider family, attachment types/limits, local-context support, and explicit filesystem/shell declarations. Browser-companion registration is rejected unless filesystem and shell are explicitly false. An unknown, duplicate, malformed, provider-mismatched, privileged-browser, or wrong-channel surface fails closed. Protocol 4 binds `surface_id` to capability evidence and the outgoing audit.

## Browser companion boundary

The companion allowlist contains only heartbeat, active workspace, provider-session lookup, capture, prepare/send acknowledgement, constrained resource/representation download, and constrained provider-asset capture/status. It has no generic URL fetch, filesystem, shell, command, Git, credential, or arbitrary-path endpoint.

Provider DOM selectors and native acceptance mechanics remain isolated in `extension/provider-adapters.js`. The send coordinator consumes the adapter contract and transaction states rather than provider selectors. The service verifies surface/provider identity before preparing context. A future browser adapter must add a registry contract, explicit companion host/origin policy, fixtures, and live validation; adding a provider string to core retrieval is not sufficient.

## Delivery planning

`planContextDelivery` receives current query, provider-neutral retrieval output, Project Space, and surface ID. It records:

- detected text/file/visual intent;
- selected text source IDs;
- bounded visual representations and native files;
- exact resource/version/representation IDs and download paths;
- capability/size limits and explicit fallback/block reasons.

Current named visuals are preferred to unrelated recent visuals. Browser surfaces can receive security-cleared original visuals, rendered PDF pages, and bounded approved files. A surface without image delivery can use matching current OCR text only when that is an honest fallback; otherwise visual intent blocks. Missing/non-cleared visual evidence and explicit over-limit attachments block rather than disappearing. The planner accepts an injected registry; the synthetic `test-provider.web` acceptance case proves text+image planning and local-only visual rejection without changes to retrieval, freshness, or planner core.

## Local-agent bridge

Opening Codex/Antigravity from the dashboard requires a registered repository root with unchanged canonical identity. Harness creates a random token, stores only its hash, scopes it to Project Space/root/agent and fixed read-only capabilities, and expires it within a bounded lifetime. The token and helper location are inherited only by the launched process.

`aih-context` commands are fixed: `status`, `query`, `sources`, `resource`, and `visual`. Status/query results include the selected Project Space's Project Instructions plus global/project personalization under the documented trust hierarchy. The API returns current Project Space evidence and opaque IDs; it cannot mutate the database, files, roots, instructions, Git state, or jobs. Visual bytes stream from current version-linked vault artifacts without creating a file in the repository. Revocation and expiry fail closed.

## Adding a future adapter

1. Define a unique surface ID, provider family, channel, version, and explicit capability limits.
2. Register it through `SurfaceRegistry`; do not add provider conditionals to retrieval.
3. Add a delivery-planner matrix case and unknown/capability-failure tests.
4. For browser adapters, add strict origins/hosts, DOM fixtures, exact acceptance evidence, and protocol identity.
5. For local adapters, require registered-root launch and scoped read-only context; do not expose private database or broad Projects-parent access.
6. Document coverage and live-validation limitations. No adapter is “supported” solely because unit tests pass.
