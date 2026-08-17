# AI Harness 0.8.0 pre-trial acceptance

This document is the acceptance gate for the local pre-trial hardening pass. It separates behavior proven by local automation from behavior that still requires a signed-in live ChatGPT or Gemini surface. A green local test result is not a claim that a provider DOM is compatible.

## Product guarantees

- `Project Current` is created only after required roots, immutable resource versions, the retrieval index, repository state, current native-chat capture, and the security policy pass one fail-closed verification.
- A managed send is prepared from the exact current prompt and is bound to its attempt ID, prompt hash, provider route, protocol version, Project snapshot, corpus generation, index generation, attachment versions, and security result.
- The companion does not record `sent` after clicking a native control. It waits for strong or corroborated provider-acceptance evidence and the service re-verifies disk and repository state before acknowledging delivery.
- A service restart converts abandoned prepared transactions to an auditable error. It never promotes them to sent.
- Original messages, resource versions, and captured provider assets are retained. Indexes, working state, and outgoing context are derived and rebuildable.
- User-selected native attachments and clipboard images must be durably archived before managed replay. Observed references without bytes keep preservation/history partial and are never described as preserved.
- Guaranteed sends use a double-inventory persisted-manifest barrier and hash every candidate delta; explicit full-integrity verification rehashes the whole corpus. Speculative retrieval never replaces that barrier.
- Browser integration can call only an explicit companion API allowlist. It has no filesystem path API, shell API, Git API, credential API, generic URL proxy, or local-agent launcher.
- Local coding-agent launch is dashboard-only and accepts only a Project Space workspace ID, a registered repository-root ID, and the fixed `codex` or `antigravity` identifier.

## Automated acceptance coverage

Run:

```powershell
npm test
npm run doctor
npm run dev:status
```

The automated suite covers:

1. Fresh disk changes replacing current resource versions while retaining old immutable versions.
2. Required-root disappearance blocking and optional-root disappearance excluding stale indexed content.
3. Double-pass root hashing, current-version-only retrieval, exact source/version provenance, and post-prepare disk-change rejection.
4. User reasoning and explicit decisions outranking ordinary assistant prose, while current files remain authoritative for current-state questions.
5. Secret filenames, content credentials, token families, prompt injection, local-only roots, traversal, encoded traversal, alternate separators, symlinks, Windows ADS, reserved device aliases, and Unicode normalization.
6. One-use companion pairing, extension identity binding, origin validation, and operation allowlisting.
7. Synthetic ChatGPT and Gemini DOM fixtures for primary/alternate selectors, hidden duplicate controls, empty established conversations, messages, streaming state, and attachment evidence.
8. Every managed-send transaction state: `IDLE`, `PREPARING`, `PREPARED`, `ATTACHING`, `REPLAYING`, `WAITING_FOR_PROVIDER_ACCEPT`, `DONE`, and `ERROR`.
9. Exact attempt/prompt/route/protocol binding, uncertain acceptance rejection, successful strong acceptance, crash recovery, and outgoing provenance audit.
10. Provider asset URL scheme/origin restrictions and explicit lifecycle states: `DISCOVERED`, `FETCHING`, `CAPTURED`, `UNAVAILABLE`, `AUTH_REQUIRED`, `CORS_BLOCKED`, `EXPIRED`, and `FAILED`.
11. PDF fail-closed behavior, retry/rebuild, input/page/pixel/output/time bounds, and per-tool diagnostics.
12. Office formats as explicit immutable attachment-only resources. AI Harness does not pretend that OOXML text extraction succeeded.
13. Real hybrid/scanned PDF metadata, digital text, page images, embedded images, OCR, deduplication, version/page/region provenance, and scratch cleanup.
14. OCR prompt-injection evidence and OCR secret scanning/local-only enforcement.
15. Protocol-4 provider-neutral surface registry, capability matrix, unknown/future adapter contracts, and query-specific visual/file planning.
16. Versioned instructions/personalization trust order and outgoing audit binding.
17. Scoped local-agent status/query/sources/resource/visual capabilities, hashed token, expiry/revocation, and no database import.
18. UI APIs for resources, jobs, coverage, instructions, personalization, security, backup, and diagnostics; no generic command/path API.
19. Safe update classification using temporary Git repositories for equal, behind, dirty, feature branch, ahead, diverged, and missing-remote states; the updater also has static assertions for backup, tests, doctor, development status, fast-forward-only behavior, and absence of hard-reset rollback.
20. Registered-repository-only Codex/Antigravity resolution and fixed tool capability reporting.
21. Real local HTTP integration for pairing, capture, cross-provider retrieval, prepare-send, provider-acceptance acknowledgement, current attachment release, unauthenticated rejection, and required-root failure.
22. Direct native-input descriptor/byte capture, clipboard OCR cross-provider continuity, late provider-message provenance backfill, exact approved-root reconciliation, ambiguous non-merge, and exact save-copy export.
23. Warm manifest verification with zero unchanged hashes/processes, one-edit/one-hash delta, generation-bound speculative retrieval, bounded session deltas/rebootstrap, and cache invalidation for file/chat/instruction/policy/surface changes.
24. Always-consider retrieval under recency pressure, superseded knowledge exclusion/historical recovery, context-critical fail-closed readiness, high-confidence rename continuity, and bounded/recoverable/cancellable job queues.
25. Edited/regenerated provider message revisions with visible/alternate path provenance, current repository branch/HEAD/dirty working-set evidence, deterministic high-authority conflict notices, class-balanced retrieval budgets, and optional semantic candidates that reject cross-workspace results.
26. Same-origin protection for the shutdown lifecycle, UI-safe Project Space tracking removal that preserves live files/archive, instruction/personalization history inspection, retained-storage breakdown, and job cancellation controls.

## UI-only normal-use acceptance scenario

After installation, a normal user can perform the following without a terminal: launch Harness; create/select or safely remove tracking for a Project Space without deleting its files/archive; choose and review a detected repository through the native folder picker; add PDF/image/files through Project Space; configure Project Instructions and global/project personalization and inspect their prior versions; verify current sources; pair/revoke the browser companion; open ChatGPT, Gemini, Codex, or installed Antigravity; inspect exact outgoing context/provenance; review resource versions/representation coverage and retained-storage classes; retry/cancel failed or running processing, or rebuild stale derived data; run diagnostics; create a backup; inspect/update root policy; inspect update eligibility; run safe Update & Restart when eligible; and recover a blocked source with the displayed retry/policy actions. The dashboard exposes fixed actions and typed identifiers—never a generic command runner or browser-companion path capability.

## Provider capability contract

The service and extension use companion protocol version 4. Readiness is false when the versions differ or the provider adapter reports an unhealthy capability.

Each provider adapter reports:

- adapter and protocol version;
- active visible composer detection;
- active send-control detection, including disabled state;
- extracted message count and established-conversation identity;
- streaming detection;
- provider attachment input and composer-scoped attachment evidence;
- conversation scroller detection;
- stable failure codes.

An established provider conversation with zero extracted messages is a capability failure. It is not interpreted as a synchronized empty chat.

## Native-send acceptance contract

The companion intercepts click and unmodified non-repeating Enter sends. Shift+Enter, modifier keys, key repeat, and IME composition are not managed as sends. Duplicate clicks/keys coalesce while a transaction is active. Replay bypass is scoped to the current attempt only.

Provider acceptance uses several independent signals: a new captured message, streaming start, composer clearing, send-control transition, and route transition. A new message or streaming start is strong evidence; otherwise two signals are required. Timeout is recorded as `PROVIDER_ACCEPTANCE_UNCERTAIN`, the prompt is preserved when safe, and the run is not marked sent. A later capture repairs that audit state only when the provider's user-message bytes exactly match the prepared provider-text hash; repaired acceptance is labeled `reconciled` with the matching provider message ID and prior failure code.

## Attachments and provider-generated assets

Prepared native attachments are selected by current resource/version ID. Before the service releases bytes, it resolves the registered root again and hashes the live source. A changed, missing, moved, or policy-blocked source fails closed. Provider confirmation compares composer-scoped inventories before and after attaching and requires new filename evidence; historical messages, hidden duplicates, and prompt text are excluded.

If automatic attachment fails, the companion exposes a one-click fallback. That fallback performs a new prepare and retrieves the current approved version; it does not ask the user to browse for a file. Its outgoing audit records `attachment_mode=fallback`, the failed source run, the previously requested version IDs, and the newly verified current versions, so a stale version cannot be silently reused.

User-selected file input, drag/drop, and clipboard bytes are captured in the page while they are available, registered as `direct_input`, and uploaded only against an authenticated server-issued asset descriptor with an empty source URL and a 25 MiB bound. The managed send fails before preparation if any required user input remains unpreserved. After provider acceptance assigns a message ID, the association is backfilled into the resource and relationship audit.

Provider-generated assets are discovered in the conversation DOM and assigned local asset IDs. Before any provider request, the background obtains an authenticated server-issued descriptor for that exact discovered asset and fetches the stored URL rather than a message-supplied URL. HTTPS assets use the signed-in provider session and a 100 MiB bound. Provider-origin `blob:` assets use a separate page-byte path capped at 25 MiB. The service checks provider origin, capture strategy, exact source equality, authentication, expected MIME, byte limits, and immutable archival. It is not a general URL fetch service.

## Resource capabilities and bounds

- Text/code: UTF-8 validation, 8 MiB extraction limit, bounded chunks.
- PDF: 200 MiB immutable-input limit, 5,000-page metadata/admission limit, 144-DPI rendering, 45-million-pixel per-page/600-million-pixel aggregate limits, 64 MiB tool-output bounds, 60-second per-tool baseline timeout, and explicit blocked/partial coverage. PDFs over 80 pages receive an initial bounded 24-page representation pass, followed by automatic asynchronous eventual completion in the background. Heavy multimodal tools (pdftoppm, tesseract) are executed via non-blocking asynchronous subprocesses, ensuring the UI and API remain responsive during large project ingestion. Bounded pagination on UI endpoints prevents large projects from overwhelming browser memory. An explicit later page request materializes that exact current page on demand from the immutable original, performs OCR-based secret analysis, and either delivers the verified page or fails closed. An unrelated partial/failed heavy document does not block an ordinary verified text turn; marking it Context Critical restores whole-resource fail-closed behavior.
- PNG/JPEG/WebP: 200 MiB immutable-input limit plus original visual and bounded Tesseract OCR/region/confidence where supported by the installed Leptonica build; coverage is explicit and OCR is untrusted evidence.
- PDFs: immutable original, metadata, per-page digital text, rendered pages, embedded images where practical, OCR, and page/region provenance.
- DOCX/PPTX/XLSX and legacy Office: immutable, current, provider-native attachment-only. No extraction claim.
- Prepared browser attachment transfer: 25 MiB companion transfer limit.
- Provider asset capture: 100 MiB limit and constrained MIME families.
- Context envelope: bounded whole-source selection with explicit exclusions; no provenance-breaking partial source truncation.

## Safe Update & Restart

Automatic update is available only from the canonical repository root, on `main`, with a clean worktree, a configured `origin/main`, no local-only commits, and a strict behind-only relationship. The flow fetches, creates an integrity-checked SQLite backup, applies `git merge --ff-only`, installs dependencies, runs tests/doctor/development status, and restarts the same source. Validation failure uses a `--keep` rollback to the old revision and refuses to overwrite unexpected changes. Project repositories and private Harness data are outside the application checkout.

The dashboard displays running source, application/protocol version, branch, HEAD, dirty state, ahead/behind/diverged state, and update eligibility. Network fetch happens only on explicit refresh/update actions.

## Service and recovery behavior

The launcher starts the localhost service hidden and stores logs under the private Runtime directory; the dashboard may be closed after launch. It refuses to silently coexist with a different source tree on port 4317. Watchers debounce changes, mark Project state stale immediately, queue priority-bounded verification, recover missing watchers periodically, and are closed during shutdown. Queued/running fixed jobs recover safely after a service restart; queued jobs can be cancelled and admission fails closed under backpressure. Shutdown checkpoints SQLite. Content-addressed vault writes use temporary files and atomic rename. SQLite backup uses checkpoint, `VACUUM INTO`, an integrity check, and a SHA-256 manifest.

## External compatibility validation still required

The following cannot be proven without live, signed-in provider testing and therefore remain explicit trial gates:

1. Current production ChatGPT selector compatibility for every account/experiment layout.
2. Current production Gemini selector compatibility for every account/experiment layout.
3. Actual native click/Enter event ordering and provider acceptance signals under live streaming, route transitions, slow networks, IME, and provider experiments.
4. Actual provider attachment input behavior and composer confirmation for PDF, Office, and image files.
5. Actual authenticated provider-generated asset URLs, redirects, expiry, CORS behavior, and MIME responses.
6. Long, lazy-loaded, edited, branched, or partially archived conversations on both providers.
7. Browser extension reload/update behavior in the user’s installed Chrome/Edge profile.
8. Installed Codex and Antigravity executable launch behavior on the user’s machine.

Until those checks pass, the correct release statement is: **local implementation and automated pre-trial hardening complete; live provider compatibility unverified**. Provider capability failure, protocol mismatch, uncertain acceptance, attachment uncertainty, or asset-capture uncertainty must remain visible and fail closed.
