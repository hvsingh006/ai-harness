# AI Harness agent instructions

## Purpose
AI Harness is a local-first continuity layer around native ChatGPT and Gemini. Project Spaces own durable files, retained chat history, current working state, and retrieval. Native AI chats are working surfaces, not the source of truth.

## Repository boundary
- Treat this Git repository as the writable development boundary unless the user explicitly grants another path.
- The canonical Windows checkout is `%USERPROFILE%\Documents\AI Workspace\Projects\ai-harness` by default.
- Persistent private Harness data lives separately at `%USERPROFILE%\Documents\AI Harness` by default.
- Never commit, delete, move, bulk-read, or rewrite the private Harness data directory unless the user explicitly asks for a narrowly scoped data task.
- Never commit databases, archives, provider exports, credentials, tokens, `.env` files, SSH material, or browser-profile data.

## Before changing code
1. Run `git status --short --branch` and preserve unrelated user changes.
2. Read `docs/PRODUCT_SPEC.md`, `docs/ROADMAP.md`, and `docs/DEVELOPMENT_WORKSPACE.md` for product constraints relevant to the task.
3. Prefer the existing architecture and Node built-ins. Avoid adding dependencies unless they materially improve reliability or security.

## Product invariants
- Context freshness and security are higher priority than UI expansion.
- Project source/history must remain durable even when native chats are replaced or providers change.
- Originals are authoritative. Derived summaries/indexes must be rebuildable.
- ChatGPT and Gemini must not receive arbitrary filesystem or shell capability through the browser companion.
- Application/source checkout and private Harness data must remain separate directory trees.
- Do not add AI providers or product modes unless explicitly requested.

## Validation
For code changes, run at minimum:
- `npm test`
- `npm run doctor`
- `npm run dev:status` when changing workspace, Git, installer, or agent integration behavior

If a command cannot run because the Harness service/browser companion is intentionally not running, distinguish that non-blocking condition from actual installation failures.

## Scoped Harness context for local agents
- When Codex or Antigravity is opened from the Harness UI, the process receives an expiring, read-only Project Space context session.
- On Windows, use `node $env:AIH_CONTEXT_HELPER status`, `query "..."`, `sources`, `resource <opaque-id>`, or `visual <opaque-id>` when those environment variables are present. The visual command streams verified bytes and does not create a repository file.
- The helper talks only to the localhost Harness API. It does not open the Harness database, grant another workspace/root, or add write capability.

## Git safety
- Do not use `git reset --hard`, `git clean`, force-push, or destructive history rewriting unless explicitly requested for a recovery task.
- Stage only intended files when the worktree is mixed.
- Inspect the final diff before committing.
- Commit and push only when the user asks, or when the current task explicitly includes publishing the completed implementation.
