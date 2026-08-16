# Project Space

AI Harness workspaces are durable project spaces backed by real folders.

## Project filesystem

Every managed Project Space has a normal directory under the persistent `Projects/` directory. Drag/drop and folder uploads preserve relative paths and write the actual files there.

These files are not hidden inside SQLite and are not owned by ChatGPT, Gemini, NotebookLM, or the Harness source repository. They can be edited normally in Explorer, VS Code, Office, or other tools.

The Harness indexes the folder on workspace refresh. Common build/cache directories such as `.git`, `node_modules`, `dist`, and `build` are skipped by the first prototype indexer.

## Existing projects

A workspace can attach to an existing folder. The folder stays where it is. This is the intended model for existing code repositories and future Codex/coding-agent integration.

## Archive relationship

The current project folder and the immutable archive are separate:

- project files are the live working copy;
- archived artifacts are source snapshots and provider/chat assets retained for provenance and recovery.

Deleting a native AI chat must not delete either the project folder or archived source material.

## Provider handoff

Fresh AI sessions receive a bounded project manifest and can retrieve relevant original resources. Large projects are progressively retrieved rather than injected wholesale into one context window.
