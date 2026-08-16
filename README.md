# AI Harness

A local, provider-neutral continuity and archive layer for working in **native** ChatGPT, Gemini, NotebookLM, and future AI services.

## Product thesis

**Chats are disposable. Workspaces are durable. Originals are never replaced by summaries.**

The harness exists to make AI more useful for learning, development, research, and direction without turning the user into a passive consumer of answers.

## What the harness owns

- complete capturable conversation archive
- exact imported provider exports
- canonical copies of files, PDFs, images, and other assets
- provider-neutral workspaces
- current working state and next actions
- source-linked memories and decisions
- learning attempts, misconceptions, and mastery evidence
- development state, architecture, experiments, bugs, and technical decisions
- cross-provider search and handoff context

## What the harness does not replace

- ChatGPT UI and native capabilities
- Gemini UI and native capabilities
- NotebookLM / Gemini notebook study and source features
- future provider-specific features that are better used natively

## Archive model

The data system deliberately separates two layers:

1. **Lossless archive**: raw messages, raw provider records, exact files/assets, provider URLs, metadata, and hashes.
2. **Derived working state**: summaries, memories, decisions, learning state, tasks, and context packets.

The derived layer can be regenerated. It is never allowed to be the only copy of important source information.

A native chat is only `safe_to_delete` after the required capture stages are complete:

- full raw transcript
- attachments/assets mirrored
- derived state updated
- search index updated

Live browser capture is currently best-effort and intentionally stays `captured_incomplete` until completeness can be verified.

## Run prototype

Requires Node.js 22.5 or newer.

```bash
npm start
```

Open:

```text
http://127.0.0.1:4317
```

## Browser companion

In Chrome or Edge:

1. Open the browser extensions page.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `extension/`.
5. Open ChatGPT, Gemini, or NotebookLM.

Current companion functions:

- automatically capture newly loaded native chat content every few seconds, with a manual Capture now fallback
- best-effort mirror accessible conversation attachments/images into the local vault
- display a stable AI Harness label directly on recognized native chats
- retain provider chat IDs/routes/URLs for archive reconciliation
- bring an archived chat back into the current prompt as source context
- insert the active workspace context into a fresh native chat
- copy the context packet
- open the local harness

## Historical imports

The importer is intentionally lossless-first. Point it at an **extracted** provider export directory. Every file is hashed and copied into the immutable local vault before provider-specific parsing.

ChatGPT export:

```bash
npm run import -- chatgpt /path/to/extracted-export ws-harness
```

Generic Gemini / NotebookLM / other provider archive:

```bash
npm run import -- gemini /path/to/extracted-export ws-harness
npm run import -- notebooklm /path/to/extracted-export ws-harness
```

The ChatGPT importer currently parses `conversations.json` into sessions/messages and archives every other exported asset. Generic provider imports preserve all files first; provider-specific parsing is incremental work.

## Data and privacy

Runtime state is under `data/` and excluded from Git. The vault is content-addressed by SHA-256. Secrets belong in `.env`, also excluded.

Git tracks source code, schema, documentation, and tests. Personal conversation history does **not** belong in Git.

## Repository

This working tree is the `ai-harness` project. It preserves the original prototype Git history. The private GitHub remote is `hvsingh006/ai-harness`.

See:

- `docs/PRODUCT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/IMPORTS.md`


## Resource use

Provider handoffs explicitly instruct the AI to use relevant prior prompts, prior model responses, raw archive history, files, PDFs, images, notebook sources, code, native tools, and current web information. If the corpus is too large, the harness preserves all of it and progressively retrieves smaller relevant subsets rather than discarding history. See `docs/RESOURCE_POLICY.md`.

## Chat identity and labels

Native chats receive a Harness overlay label when recognized. Provider chat identifiers are stored separately from titles and URLs so imported or archived chats can reconcile with later live sessions. See `docs/CHAT_IDENTITY.md`.

## Prototype installation

The current browser companion is an unpacked Chrome/Edge extension. See `docs/INSTALL.md`. The dashboard shows a bright red **Harness ready** dot after the companion checks in.

## Project spaces

A Harness workspace is also a durable project space. The local UI supports dragging or selecting documents, PDFs, images, datasets, folders, and other working material into the workspace. Originals are stored in the canonical content-addressed vault and remain available independently of any individual ChatGPT, Gemini, NotebookLM, or future coding-agent session.

See `docs/PROJECT_SPACE.md` for the resource model and `docs/CODING_ADAPTERS.md` for the planned provider-neutral coding-tool boundary.
