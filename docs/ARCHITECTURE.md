# AI Harness architecture

## Authority model

```text
Project Space (durable authority)
├── explicitly approved live roots
├── immutable resource/message/archive versions
├── rebuildable extraction + SQLite FTS5 chunks
├── compact deterministic working state
├── verified per-send snapshots and audits
│
├── native ChatGPT chats (working surfaces)
└── native Gemini chats (working surfaces)
```

Original files/messages are authoritative. Derived chunks, working state, retrieval rankings, and context envelopes can be rebuilt. Provider conversations can be replaced without replacing the Project Space.

## Verified managed-send flow

```text
native click / Enter
  → capture adapter synchronizes visible chat
  → companion authenticates to 127.0.0.1
  → approved roots canonicalized and fully reconciled
  → changed bytes archived/versioned/extracted/indexed
  → Git repository state observed locally
  → corpus/index/chat generations checked
  → CURRENT snapshot or structured BLOCKED result
  → current-version + cross-provider retrieval
  → local-only filter and secret scan
  → outgoing context/source audit
  → current binary attachments confirmed when needed
  → context injected and native Send replayed exactly once
```

Watchers mark state stale and perform background indexing for latency. They are never the proof of freshness; every guaranteed send performs the reconciliation barrier again.

## Module boundaries

- `security/paths.mjs`: realpath/canonical containment, traversal rejection, secure root walking, symlink skipping.
- `security/secrets.mjs`: sensitive filename policy and deterministic outgoing secret detection/redaction.
- `security/companion-auth.mjs`: private install credential, one-time pairing, token hashing, extension identity/origin checks.
- `resources.mjs` and `resource-extractors.mjs`: resource identity, immutable versions, vault preservation, extraction, chunk/FTS indexing.
- `repository.mjs`: safe argument-array Git observation without credential transmission.
- `chat-capture.mjs`: stable provider-ref reconciliation, capture evidence/coverage, clean-vs-raw managed messages.
- `freshness.mjs`: pre-send generations, root/repository/chat verification, snapshots, deterministic working state.
- `retrieval.mjs`: FTS/BM25 candidates plus user/decision/current-version/recency/cross-provider weighting.
- `outgoing-context.mjs`: context budget, trust envelope, attachment manifest, secret filtering, provenance audit.
- `server.mjs`: HTTP routing, same-origin dashboard endpoints, authenticated companion endpoints, watchers, and legacy UI compatibility.
- `extension/provider-adapters.js`: provider DOM selectors and attachment mechanics isolated from the send coordinator.
- `extension/content.js`: capture completeness and single-replay send state machine.

## Trust hierarchy

1. Harness security policy
2. current explicit user request
3. Project Space configuration
4. retrieved project material
5. retained assistant responses

Retrieved content is never executed and cannot change permissions. ChatGPT/Gemini receive selected approved context and opaque attachment bytes only—not filesystem paths, shells, Git credentials, SSH material, or generic local APIs.

## Freshness versus coverage

Freshness is `CURRENT`, `VERIFYING`, `STALE`, `BLOCKED`, or `ERROR`. A `CURRENT` snapshot means every known required root was reachable/canonical, its inventory and current versions were reconciled, required extraction/indexing succeeded, repository state was observed, the visible native chat synchronized, generations matched, and security policy was active.

History coverage is independently `COMPLETE`, `PARTIAL`, or `UNKNOWN`. A complete current source corpus does not fabricate uncaptured provider activity. `safe_to_delete` is separate from both.

## Provider limitations

ChatGPT/Gemini DOMs and native file controls are not stable APIs. Adapters use versioned selectors and explicit capture/attachment evidence. If a provider control cannot be recognized, lazy history cannot be proven complete, or an attachment is not reflected by the native UI, Harness reports the limitation and does not claim success. Real long-conversation and provider-update smoke testing remains an ongoing release gate.
