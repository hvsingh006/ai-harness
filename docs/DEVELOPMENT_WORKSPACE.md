# Development workspace

AI Harness uses three explicit boundaries on Windows.

## Live development projects

Default parent:

```text
%USERPROFILE%\Documents\AI Workspace\Projects
```

The canonical AI Harness checkout and runtime source is:

```text
%USERPROFILE%\Documents\AI Workspace\Projects\ai-harness
```

`AI_HARNESS_DEV_ROOT`/`AI_HARNESS_REPO_ROOT` continue to configure development tooling. `HARNESS_PROJECTS_ROOT` configures the managed live Project Space parent. Do not create another installed source copy.

## Private Harness state

Default:

```text
%USERPROFILE%\Documents\AI Harness
```

This contains SQLite, archives, imports, backups, derived indexes/audits, and `.harness` runtime credentials/staging. `HARNESS_WORKSPACE_ROOT` overrides it. It must remain a separate tree from the source checkout and is not a normal live-repository parent.

## Least privilege

Open Codex/Antigravity from one repository root, not the entire Projects parent. Local coding agents may edit/test the current repository when explicitly granted. ChatGPT/Gemini companion operations are separately authenticated and only receive selected provider-allowed evidence or opaque current attachment bytes; they never receive generic filesystem/shell/Git operations or credentials.

## Git/runtime invariant

`npm run dev:status` reports the canonical path, branch, HEAD, worktree state, origin/upstream, and whether runtime source matches the checkout. `update-and-launch-harness.cmd` keeps the fail-closed workflow: canonical clean-main check, ahead/behind/diverged classification, SQLite integrity backup, fetch and fast-forward only, dependency setup, tests/doctor/development-status validation, `--keep` source rollback on failure, and health-checked restart from the same checkout.

The dashboard may launch Codex or Antigravity only for a repository root already registered to the selected Project Space. The request carries workspace/root IDs and a fixed tool name, never an arbitrary path or command. This local capability is not exposed to the browser companion.

## Managed-project migration

New managed Project Spaces use `AI Workspace\Projects`. Existing 0.7 managed folders under private `AI Harness\Projects` are not deleted or silently moved. Setup offers copy/hash-verify/transactional-reference migration and retains the source fallback. Attached external roots remain untouched.
