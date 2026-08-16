# AI Harness

> 0.8.0 pre-trial status: local implementation and automated hardening are complete; live signed-in ChatGPT/Gemini compatibility remains unverified. See [docs/PRETRIAL_ACCEPTANCE.md](docs/PRETRIAL_ACCEPTANCE.md).

AI Harness is a local continuity layer for working in native ChatGPT and Gemini. Project Spaces retain authoritative files, repository state, provider history, and provenance while native chats remain replaceable working surfaces.

## 0.8 context-integrity contract

A Harness-managed native send proceeds only after the selected Project Space reaches a verified `CURRENT` snapshot. Immediately before replaying the normal ChatGPT/Gemini Send action, Harness:

1. synchronizes the visible native conversation;
2. verifies every required approved root by canonical path;
3. hashes the current file inventory and archives changed versions;
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
  .harness\                   # private runtime credential/staging
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

## Resource behavior

- Approved roots are explicit and independently configurable as required/optional, indexed/unindexed, and provider-allowed/local-only.
- Symlinks and junction-style escapes are not followed during indexing; `.git` internals and generated dependency/build trees are excluded.
- Logical resources retain immutable SHA-256 versions; normal retrieval joins only the current version.
- Text/code uses deterministic line-aware chunks. PDF extraction uses local `pdftotext` with page provenance. If it is unavailable or extraction fails for a required PDF, guaranteed currentness blocks rather than pretending the PDF was indexed.
- Unsupported Office/binary formats remain truthfully versioned and can be selected as current provider-native attachments when relevant.
- Images retain current hash/type/dimensions when available and can be attached automatically. Send remains paused unless the provider UI confirms the attachment.
- High-confidence secrets block a source or prompt; lower-confidence token material is deterministically redacted. Findings store only rules, locations, and masked fingerprints.

## Retention and trust

Raw provider messages, imports, assets, files, and prior resource versions remain authoritative. FTS indexes, snapshots, workspace state, and context envelopes are rebuildable derived data. Captured managed messages keep the lossless provider-visible envelope but index the clean user-authored text so context does not recursively pollute history.

Retrieved files and old AI responses are evidence, not authority. They cannot alter approved roots, grant shell/filesystem permissions, disable scanning, or change security policy. Explicit user reasoning and decisions receive stronger retrieval weight than old assistant prose.

`safe_to_delete` remains stricter and separate from `Project Current`: raw transcript, attachments, derived state, and search indexing must all be complete before deletion safety is claimed.

## Validation and updates

```bash
npm test
npm run doctor
npm run dev:status
```

Use `update-and-launch-harness.cmd` for the fail-closed update flow: inspect the worktree, back up private metadata, fetch/fast-forward only, validate, roll source back on failure, and restart the same canonical checkout. It never creates a duplicate installed source tree.

See `docs/ARCHITECTURE.md`, `docs/STORAGE.md`, `docs/PROJECT_SPACE.md`, `docs/TESTING.md`, and `docs/ROADMAP.md`.
