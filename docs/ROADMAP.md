# AI Harness roadmap

## 0.8.0 pre-trial hardening

Implemented locally: fail-closed protocol-4 surface capability detection, acceptance-based native-send transactions, prepared-context invalidation, constrained provider asset capture into the unified resource model, current-version native attachments, Poppler/Tesseract multimodal representations, representation coverage, provider-neutral delivery plans, UI-only daily administration, versioned instructions/personalization, scoped read-only Codex/Antigravity context, background jobs, safe update/backup/rollback/restart, Git/runtime diagnostics, crash recovery, and expanded adversarial/end-to-end tests.

Remaining gate: live signed-in ChatGPT/Gemini compatibility validation only. See `docs/PRETRIAL_ACCEPTANCE.md`; do not convert external unknowns into success claims.

## 0.8 context integrity and security — implemented

- [x] separate private state and live `AI Workspace\Projects` roots
- [x] multiple explicitly approved roots with per-root freshness/index/transmission policy
- [x] centralized canonical path containment and symlink/junction escape prevention
- [x] immutable logical resource versions with archive preservation
- [x] text/code/PDF extraction, deterministic chunks, SQLite FTS5, and current-version-only retrieval
- [x] local repository branch/HEAD/dirty/staged/unstaged/untracked/tree observation
- [x] cross-provider retrieval with explicit user reasoning/decisions weighted strongly
- [x] separate deterministic freshness and honest history coverage
- [x] verified snapshots and fail-closed pre-send barrier
- [x] outgoing secret file/text policy and prompt-injection trust boundary
- [x] one-time companion pairing, authenticated allowlisted localhost operations, strict origin behavior
- [x] normal native click/Enter interception with single replay and preserved message on failure
- [x] current binary/image attachment preparation with provider confirmation
- [x] outgoing sanitized context/source/snapshot/security audit
- [x] Project Current/Blocked/source-policy inspection UI
- [x] safe copy-and-verify legacy managed-project migration
- [x] integration coverage for immediate disk change and unavailable required root
- [x] immutable version-linked multimodal representations and unified digital/OCR retrieval
- [x] scanned/hybrid PDF, embedded-image, OCR injection/secret, and cleanup acceptance tests
- [x] provider-neutral surface registry and query-specific delivery capability matrix
- [x] scoped local-agent context helper with token hashing, expiry, revocation, and no database access
- [x] versioned project instructions and restrained personalization with explicit trust order
- [x] Resource/Instructions/Security control-plane UI and fixed processing/backup/diagnostic jobs

## Reliability validation still required on live providers

- [ ] validate complete progressive capture against very long current ChatGPT conversations
- [ ] validate complete progressive capture against very long current Gemini conversations
- [ ] maintain provider selector fixtures as their DOMs change
- [ ] validate native attachment confirmation across provider UI variants and account states
- [ ] improve reconciliation/import coverage for activity created while Harness was not running
- [ ] consider bundled/cross-platform Poppler/Tesseract distribution if clean-machine Windows provisioning proves fragile

These limitations remain explicit and fail closed where they affect freshness or native-send correctness. They do not justify a replacement chat UI, another provider, a permanent provider conversation, or weakened security.

## Later, after daily-use validation

- background indexing queue observability and performance tuning for very large repositories
- richer current-result/image associations and previews
- optional embeddings only if they improve retrieval without replacing FTS/source provenance
- performance tuning and richer read-only local-agent visual consumption after daily-use evidence

Learning and development remain use cases, not top-level product modes.
