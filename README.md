# AI Harness

A local continuity and project layer for working in **native ChatGPT and Gemini** without restarting your context every time you open a new chat or switch services.

## Product thesis

**Chats are disposable. Project spaces are durable. Originals are never replaced by summaries.**

The Harness exists to keep project context, files, and chat history continuous across ChatGPT and Gemini while improving productivity and learning without replacing the user's critical thinking.

## 0.6 storage model

Application code and personal data are physically separate.

Recommended Windows layout:

```text
%LOCALAPPDATA%\AI-Harness\app\        # Git checkout / application code

%USERPROFILE%\Documents\AI Harness\  # permanent working space
├── Projects\
├── Library\
├── Archive\
│   ├── Vault\
│   └── Imports\
├── Backups\
├── .harness\
└── harness.db
```

You can update, delete, or reclone the application checkout without deleting your projects or archive. `HARNESS_WORKSPACE_ROOT` can override the default persistent location, but the Harness refuses to place persistent storage inside its own source checkout.

See `docs/STORAGE.md`.

## Project Spaces

A Project Space is backed by a **real folder**, not just database records. Files dragged into the local app are written into that project folder while immutable archive snapshots are maintained separately when needed for provenance/recovery.

You can also attach an existing project folder without moving it.

## What the Harness owns

- complete capturable conversation archive
- exact imported provider exports
- provider chat IDs, routes, URLs, and native traceability
- real project folders plus indexed resource manifests
- immutable archived copies of provider/chat assets
- current working state and next actions
- source-linked memories and decisions
- cross-provider search and handoff context

## What it does not replace

- ChatGPT UI and native capabilities
- Gemini UI and native capabilities

## Archive model

Two layers are kept separately:

1. **Lossless source archive**: raw messages, provider records, exact assets, IDs/URLs, metadata, hashes.
2. **Derived working state**: summaries, memories, decisions, current focus, and context packets.

Derived state can be regenerated. It never replaces the originals.

A native chat is only `safe_to_delete` after raw transcript, attachments/assets, derived state, and search indexing are all verified complete.

## Start

Requires Node.js 22.5+.

Windows:

```text
start-harness.cmd
```

Or:

```bash
npm start
```

Then open `http://127.0.0.1:4317/`.

## Browser companion

Load `extension/` as an unpacked Chrome/Edge extension. It currently supports ChatGPT and Gemini native pages for capture, chat labels, context handoff, and archived-session reuse.

The requested bright red **Harness ready** indicator appears after the local service and browser companion have connected.

## Updates and backups

If the application is a Git checkout:

```text
update-harness.cmd
```

The updater creates a database backup first, then performs `git pull --ff-only`, then runs diagnostics. Personal Projects and Archive data are outside Git.

Manual commands:

```bash
npm run backup
npm run doctor
npm test
```

## Historical imports

```bash
npm run import -- chatgpt /path/to/extracted-export <workspace-id>
npm run import -- gemini /path/to/extracted-export <workspace-id>
```

The importer preserves source files before parsing them.

## Repository

Private remote: `hvsingh006/ai-harness`.

Git stores application source, tests, migration logic, and documentation only. Personal project data, chats, files, PDFs, images, the archive vault, backups, and `harness.db` remain local.

## Key documentation

- `docs/STORAGE.md`
- `docs/PRODUCT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT_SPACE.md`
- `docs/RESOURCE_POLICY.md`
- `docs/CHAT_IDENTITY.md`
- `docs/CODING_ADAPTERS.md`
- `docs/IMPORTS.md`
- `docs/TESTING.md`
- `docs/ROADMAP.md`

## Update and launch

On Windows, use `update-and-launch-harness.cmd` (installed as the **AI Harness** Desktop/Start Menu shortcut). It checks for a newer `main`, backs up data before applying an update, validates the new build, rolls application code back on failure, and launches the Harness. Project Spaces and the archive remain outside the Git checkout.
