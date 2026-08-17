# AI Harness architecture

## Companion protocol and managed-send transaction

Harness 0.8.0 uses companion protocol 4. Protocol 4 adds an explicit `surface_id` and surface-capability evidence to heartbeat, capture, prepare, and acknowledgement. The service reports the protocol in health/readiness; a missing/unknown surface or protocol mismatch is not ready and fails closed.

Native send is a transaction rather than a click callback: `IDLE -> PREPARING -> PREPARED -> ATTACHING -> REPLAYING -> WAITING_FOR_PROVIDER_ACCEPT -> DONE|ERROR`. The prepared record binds the prompt hash, provider route, attempt, protocol, current snapshot, generations, source versions, attachments, and policy. Provider acceptance must be strong or corroborated, and the service performs another deterministic source/repository verification before recording sent.

Provider-generated assets use discovered local asset IDs and provider-specific origin restrictions. User-selected files, drops, and clipboard images use a separate direct-input byte channel bound to a server-issued asset descriptor; bytes must be durable before managed replay. There is no generic companion URL fetch or filesystem endpoint.

## Authority model

```text
Project Space (durable authority)
├── explicitly approved live roots
├── immutable resource/message/archive versions
├── immutable version-linked representations
│   ├── original source/visual
│   ├── PDF metadata, digital text, page images, embedded images
│   └── OCR text/regions/confidence (untrusted derived evidence)
├── rebuildable unified chunks + SQLite FTS5
├── compact deterministic working state
├── verified per-send snapshots and audits
│
├── native ChatGPT/Gemini browser surfaces
└── scoped Codex/Antigravity local-agent surfaces
```

Original files/messages are authoritative. Derived chunks, working state, retrieval rankings, and context envelopes can be rebuilt. Provider conversations can be replaced without replacing the Project Space.

## Verified managed-send flow

```text
native click / Enter
  → capture adapter synchronizes visible chat
  → companion authenticates to 127.0.0.1
  → approved roots canonicalized and double-inventoried against persisted manifests
  → candidate bytes hashed; changed bytes archived/versioned/extracted/indexed
  → bounded multimodal representations generated and coverage recorded
  → Git repository state observed locally
  → corpus/index/chat generations checked
  → CURRENT snapshot or structured BLOCKED result
  → current-version + cross-provider retrieval
  → local-only filter and secret scan
  → provider-neutral delivery plan from registered surface capabilities
  → outgoing context/source audit
  → current binary attachments confirmed when needed
  → context injected and native Send replayed exactly once
```

Watchers mark state stale and perform background indexing for latency. They are never the proof of freshness; every guaranteed send performs the reconciliation barrier again.

On association/open, Harness queues a bounded local prewarm. After an 800 ms composer debounce it may persist a speculative retrieval result. The cache key binds workspace/session/surface/adapter/query plus corpus, index, chat, instruction, and personalization identity. Final preparation reuses it only after the mandatory reconciliation produced the same identity. No cloud model is on the critical path.

The per-session context ledger records accepted instruction/personalization versions and delivered evidence/visual versions. A fresh conversation receives a full bootstrap. Established conversations may receive deltas for at most eight sends and 30 minutes before forced rebootstrap, so provider context-window assumptions never become unbounded.

Retrieval is staged and local: structured state/current working set, visible-path and cross-provider conversation candidates, attachment relationships, FTS/exact resource candidates, then an optional workspace-scoped `SemanticRetriever`. The semantic interface is disabled by default and cannot block normal send. Soft budgets keep authoritative sources, structured state, conversation continuity, OCR/visual evidence, and history from accidentally monopolizing one packet; unused capacity is redistributed. Deterministic assertion comparison exposes unresolved query-relevant conflicts between active Project Instructions and current high-authority sources instead of silently ranking one away.

Complete provider captures mark the currently visible message graph path. Edited prompts and regenerated responses remain separate retained revisions with provider/parent IDs; current continuity prefers the visible path and keeps alternates as historical evidence. When the provider cannot prove a complete visible path, path status remains `unknown` rather than being fabricated.

## Module boundaries

- `security/paths.mjs`: realpath/canonical containment, traversal rejection, secure root walking, symlink skipping.
- `security/secrets.mjs`: sensitive filename policy and deterministic outgoing secret detection/redaction.
- `security/companion-auth.mjs`: private install credential, one-time pairing, token hashing, extension identity/origin checks.
- `resources.mjs`, `resource-extractors.mjs`, and `multimodal.mjs`: manifest/delta verification, rename continuity, resource identity, immutable versions, vault preservation, Poppler/Tesseract representations, coverage, chunk/FTS indexing, native-input/provider-output ingestion, resource policy, and safe export.
- `tooling.mjs`: deterministic trusted discovery and argument-array execution for Poppler/Tesseract.
- `surface-registry.mjs` and `delivery-planner.mjs`: provider-family/surface separation, capability contracts, and query-specific text/file/visual plans.
- `instructions.mjs`: immutable project-instruction and personalization versions plus explicit trust order.
- `agent-context.mjs`: expiring capability-scoped local-agent context sessions; local agents never open the database directly.
- `jobs.mjs`: fixed priority jobs, bounded concurrency/admission, cancellation, restart recovery, and inspectable progress; no arbitrary command job exists.
- `repository.mjs`: safe argument-array Git observation without credential transmission.
- `chat-capture.mjs`: stable provider-ref reconciliation, capture evidence/coverage, clean-vs-raw managed messages.
- `freshness.mjs`: pre-send generations, root/repository/chat verification, snapshots, deterministic working state.
- `retrieval.mjs`: staged FTS/exact/structured/conversation/relationship retrieval, optional local semantic interface, current branch/worktree and visible conversation-path provenance, class budgets, always-consider sources, historical supersession policy, and deterministic conflict surfacing.
- `context-cache.mjs`: generation- and surface-bound local speculative retrieval cache.
- `outgoing-context.mjs`: context budget, trust envelope, attachment manifest, secret filtering, provenance audit.
- `server.mjs`: HTTP routing, same-origin dashboard mutations (including lifecycle shutdown), authenticated companion endpoints, watchers, retained-storage reporting, and UI compatibility.
- `extension/provider-adapters.js`: provider DOM selectors and attachment mechanics isolated from the send coordinator.
- `extension/content.js`: capture completeness and single-replay send state machine.

## Trust hierarchy

1. Harness security policy
2. current explicit user request
3. versioned Project Space instructions
4. global personalization and optional Project Space override
5. rebuildable derived working state
6. retrieved project evidence, with explicit user reasoning weighted strongly
7. retained assistant responses

Retrieved content is never executed and cannot change permissions. ChatGPT/Gemini receive selected approved context and opaque attachment bytes only—not filesystem paths, shells, Git credentials, SSH material, or generic local APIs.

## Freshness versus coverage

Freshness is `CURRENT`, `VERIFYING`, `STALE`, `BLOCKED`, or `ERROR`. A `CURRENT` snapshot means every known required root was reachable/canonical, its double inventory and candidate hashes/current versions were reconciled, required extraction/indexing succeeded, every active context-critical resource was ready, repository state was observed, the visible native chat synchronized, generations matched, and security policy was active.

History coverage is independently `COMPLETE`, `PARTIAL`, or `UNKNOWN`. Representation coverage is separately `COMPLETE`, `PARTIAL`, `ATTACHMENT_ONLY`, `SOURCE_ONLY`, or `BLOCKED`, with per-resource/page failures. A current source can truthfully be fresh while an OCR/visual representation is partial; a query that requires the missing representation is blocked or gets an explicit supported fallback. `safe_to_delete` is separate from all three claims.

## Provider limitations

ChatGPT/Gemini DOMs and native file controls are not stable APIs. Adapters use versioned selectors and explicit capture/attachment evidence. If a provider control cannot be recognized, lazy history cannot be proven complete, or an attachment is not reflected by the native UI, Harness reports the limitation and does not claim success. Real long-conversation and provider-update smoke testing remains an ongoing release gate.
