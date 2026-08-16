# Development workspace

AI Harness uses two physically separate roots on Windows.

## AI development workspace

Default:

```text
%USERPROFILE%\Documents\AI Workspace\Projects
```

Each coding project gets its own repository beneath that root:

```text
AI Workspace\Projects\
  ai-harness\
  fpga-project\
  another-project\
```

The canonical AI Harness repository is:

```text
%USERPROFILE%\Documents\AI Workspace\Projects\ai-harness
```

Override the parent with `AI_HARNESS_DEV_ROOT` or the exact AI Harness checkout with `AI_HARNESS_REPO_ROOT`.

The running development copy and the Git checkout are intentionally the same tree. There is no separate installed source copy after migration.

## Private Harness data

Default:

```text
%USERPROFILE%\Documents\AI Harness
```

This contains the database, archive, backups, retained provider history, and managed Project Space files. It stays outside the development workspace so granting Codex or Antigravity access to a source repository does not automatically grant access to the private Harness archive.

## Native coding agents

OpenAI Codex and Google Antigravity should normally be launched from the individual repository root, not from the entire `AI Workspace\Projects` parent. This preserves least-privilege project boundaries while keeping every repository in a predictable parent location.

AI Harness includes:

```text
open-codex.cmd
open-antigravity.cmd
```

Both launch the native CLI in the canonical repository when the CLI is installed. `AGENTS.md` provides shared repository instructions; Antigravity also recognizes repository-local `AGENTS.md` context.

## Git/runtime invariant

The running AI Harness source should always correspond to the current Git checkout plus any visible local modifications. Check with:

```text
npm run dev:status
```

Normal updates remain fail-closed when the `main` worktree is dirty. `update-and-launch-harness.cmd` backs up Harness metadata, fast-forwards `main`, validates dependencies/diagnostics, rolls back source on validation failure, and launches the working revision.

## Migration

`setup-ai-workspace.ps1` or the current installer migrates the canonical source checkout from the legacy `%LOCALAPPDATA%\AI-Harness\app` location into the development workspace, updates environment variables and shortcuts, validates the checkout, and leaves private Harness data untouched.
