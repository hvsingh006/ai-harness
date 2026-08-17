# AI Harness

> 0.8.0 final pre-live status: local engine/UI implementation and automated hardening are complete, including real Poppler/Tesseract multimodal acceptance. Live signed-in ChatGPT/Gemini DOM/attachment compatibility remains deliberately unverified until the user-authorized trial. See [docs/PRETRIAL_ACCEPTANCE.md](docs/PRETRIAL_ACCEPTANCE.md).

AI Harness is a local continuity layer for working in native ChatGPT and Gemini. Project Spaces retain authoritative files, repository state, provider history, and provenance while native chats remain replaceable working surfaces.

## 0.8 context-integrity contract

A Harness-managed native send proceeds only after the selected Project Space reaches a verified `CURRENT` snapshot. Immediately before replaying the normal ChatGPT/Gemini Send action, Harness:

1. synchronizes the visible native conversation;
2. verifies every required approved root by canonical path;
3. double-inventories approved roots, compares a persisted metadata/identity manifest, and hashes/archives every candidate change;
4. extracts and indexes changed text/code/PDF resources;
5. observes repository branch, HEAD, dirty/staged/unstaged/untracked state;
6. ties corpus, index, and chat generations to a snapshot;
7. retrieves current sources plus relevant ChatGPT/Gemini history;
8. removes local-only sources and scans for secrets;
9. records the sanitized context and exact source provenance;
10. injects/attaches the verified context and replays native Send once.

If any required source, extraction/index, chat synchronization, repository check, authentication check, or security check cannot be established, guaranteed mode returns `Context Blocked`. It does not reuse a cached packet.

Freshness and history coverage are separate. `Project Current` proves the known current corpus at a snapshot; history remains `COMPLETE`, `PARTIAL`, or `UNKNOWN` according to what was actually captured.

## Storage layout

```text
%USERPROFILE%\Documents\AI Workspace\Projects\
  ai-harness\                 # canonical source/runtime checkout
  project-a\                  # normal live project material

%USERPROFILE%\Documents\AI Harness\
  harness.db                  # private metadata/index/audit state
  Archive\Vault\             # immutable source/version blobs
  Archive\Imports\
  Backups\
  Library\
  .harness\                   # private runtime credential/staging/derived scratch
```

`HARNESS_WORKSPACE_ROOT` overrides private state. `HARNESS_PROJECTS_ROOT` overrides the live managed-project parent. Explicitly linked external folders stay in place. Older managed folders under private `AI Harness\Projects` can be copied and hash-verified into the live projects root from Setup; conflicts never overwrite and the source is retained as a fallback.

## Start and pair

Requires Node.js 22.5 or newer.

```text
start-harness.cmd
```

Or run `npm start`, then open `http://127.0.0.1:4317/`.

Load `extension/` as an unpacked Chrome/Edge extension, open Harness Setup, and choose **Pair browser companion**. Pairing uses a short-lived one-time challenge; the long-lived 256-bit token stays in extension local storage and only a peppered hash is retained locally. Companion APIs are allowlisted, bound to `127.0.0.1`, origin checked, and never expose generic filesystem or shell operations.

Once paired, work in native ChatGPT/Gemini and use their normal Send button or Enter. Shift+Enter remains a newline.

Files and clipboard images added through a Project-associated native chat are captured before a managed Send can proceed. Existing approved-root files reconcile to the same logical resource only on a unique exact hash match. Files from outside approved roots and pathless clipboard images are archived as Project-owned resources without granting access to their source directory or dirtying the project repository. Their origin, provider, session, message, capture method, exact hash, and immutable version remain inspectable. Use **Save copy to project folder** only when a visible working copy is wanted.

Normal administration is UI-first: Project Space adds/links sources with the native folder picker; Resources shows immutable versions, representation coverage, processing jobs, backup, and diagnostics; Instructions manages versioned project guidance/personalization; Security & surfaces shows pairing, revocation, adapters, and scoped local-agent sessions. CLI commands are for development/recovery, not daily bookkeeping.

## Resource behavior

- Approved roots are explicit and independently configurable as required/optional, indexed/unindexed, and provider-allowed/local-only.
- Symlinks and junction-style escapes are not followed during indexing; `.git` internals and generated dependency/build trees are excluded.
- Logical resources retain immutable SHA-256 versions; normal retrieval joins only the current version.
- A persisted per-root manifest makes an unchanged send a metadata/identity fast path; candidates are hashed, final inventory is rechecked for races, and **Full integrity verification** remains available as an explicit all-byte audit.
- High-confidence same-root renames preserve the logical resource/version identity. Ambiguous moves or attachment matches remain separate instead of being merged optimistically.
- **Always consider**, **Context Critical**, **Superseded**, and provider-exclusion policies affect retrieval/readiness deterministically and invalidate speculative context.
- Text/code uses deterministic line-aware chunks. PDFs use bounded local Poppler metadata/digital text/page rendering/embedded-image extraction plus Tesseract OCR; images attempt OCR. PDFs over 80 pages receive a 24-page initial pass, followed by automatic asynchronous eventual completion. The background execution is non-blocking, ensuring the UI remains responsive, and a specifically requested later page is materialized from the immutable current original on demand. Every derived representation is linked to one immutable current version with page/region/confidence provenance and honest coverage.
- Unsupported Office/binary formats remain truthfully versioned and can be selected as current provider-native attachments when relevant.
- Images retain current hash/type/dimensions when available and can be attached automatically. Visual/file delivery requires clear OCR-derived security state; whole image/PDF originals also require complete coverage. Send remains paused unless the provider UI confirms the attachment.
- High-confidence secrets block a source or prompt; lower-confidence token material is deterministically redacted. Findings store only rules, locations, and masked fingerprints.

## Retention and trust

Raw provider messages, imports, assets, files, and prior resource versions remain authoritative. FTS indexes, snapshots, workspace state, and context envelopes are rebuildable derived data. Captured managed messages keep the lossless provider-visible envelope but index the clean user-authored text so context does not recursively pollute history.

Retrieved files and old AI responses are evidence, not authority. They cannot alter approved roots, grant shell/filesystem permissions, disable scanning, or change security policy. Explicit user reasoning and decisions receive stronger retrieval weight than old assistant prose.

`safe_to_delete` remains stricter and separate from `Project Current`: raw transcript, actual user-input attachment bytes, provider-generated asset bytes, derived state, and search indexing must all be complete before deletion safety is claimed. Merely observing a filename never satisfies this gate.

Context preparation uses only local deterministic work. Project association prewarms source/repository state; composer edits may create a generation-bound speculative retrieval draft. Final Send always runs the freshness/security barrier and can reuse a draft only when workspace, session, surface/adapter, query, corpus, index, chat, instruction, and personalization identities still match. A native-session ledger allows concise deltas, but forces a full bootstrap after eight accepted sends or 30 minutes.

## Validation and updates

```bash
npm test
npm run doctor
npm run dev:status
```

Use `update-and-launch-harness.cmd` for the fail-closed update flow: inspect the worktree, back up private metadata, fetch/fast-forward only, validate, roll source back on failure, and restart the same canonical checkout. It never creates a duplicate installed source tree.

See `docs/ARCHITECTURE.md`, `docs/MULTIMODAL_CONTEXT.md`, `docs/ADAPTER_ARCHITECTURE.md`, `docs/INSTRUCTIONS_AND_PERSONALIZATION.md`, `docs/STORAGE.md`, `docs/PROJECT_SPACE.md`, `docs/TESTING.md`, and `docs/ROADMAP.md`.
