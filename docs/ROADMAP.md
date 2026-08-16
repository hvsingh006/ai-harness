# Agile roadmap

## Sprint 0.6 - update-safe first user-test milestone

Status: ready for manual smoke testing after persistent-storage migration.

- [x] preserve original Git history under `ai-harness`
- [x] application / persistent workspace physical separation
- [x] managed real project folders under persistent Projects directory
- [x] attach existing project-folder API/UI
- [x] automatic migration from legacy application-local data
- [x] pre-update SQLite backup command
- [x] update script that backs up before `git pull --ff-only`
- [x] lossless archive schema
- [x] SHA-256 content-addressed vault
- [x] normalized raw message store
- [x] session asset inventory
- [x] capture integrity stages
- [x] ChatGPT export parser
- [x] generic provider directory archival
- [x] archive search API/UI
- [x] live browser chat snapshot capture
- [x] incremental auto-capture toggle
- [x] best-effort authenticated asset mirroring path
- [x] context packet v2 with active-learning policy
- [x] workspace next-action model
- [x] light/dark/system appearance
- [ ] packaged desktop folder picker for imports
- [x] create Project Space from UI
- [x] Windows quick-start script
- [x] doctor/preflight command
- [x] Setup & Test dashboard
- [x] extension background proxy for localhost API reliability
- [x] server-level continuity smoke test
- [x] project-space drag/drop file and folder ingestion
- [x] canonical workspace resource browser/open flow
- [x] private GitHub remote created and connector publishing enabled

## Sprint 1 - make native chats reliably disposable

Goal: full, verifiable capture rather than best-effort snapshots.

- ChatGPT complete-thread capture adapter
- Gemini complete-thread capture adapter
- NotebookLM/Gemini notebook source inventory adapter
- authenticated asset mirroring from browser context
- generated image/media preservation
- capture completeness detection
- raw DOM/provider metadata preservation
- idempotent incremental capture
- capture diagnostics
- safe-to-delete verification UI

## Sprint 2 - historical ingestion

Goal: seed the harness with existing history rather than only new chats.

- robust ChatGPT export variants
- Gemini Takeout parser as formats are validated
- NotebookLM/Google export parser as formats are validated
- project/notebook mapping heuristics
- bulk workspace assignment/reassignment
- duplicate conversation detection
- import review UI

## Sprint 3 - durable intelligence

Goal: make a fresh session continue intelligently.

- provenance graph
- workspace-state extraction
- memory extraction/review inbox
- contradiction and supersession handling
- decision ledger
- unresolved-question extraction
- task/next-action extraction
- relevance ranking
- automatic session deltas

## Sprint 4 - learning system

Goal: improve actual learning, not answer throughput.

- attempt capture
- misconception tracking
- mastery evidence
- spaced/retrieval review queue
- source-linked study objectives
- NotebookLM/Gemini notebook mappings
- optional native-study handoff modes
- explanation effectiveness feedback

## Sprint 5 - development system

- provider-neutral coding adapter contract
- Codex adapter exploration (local folder/repository and task/thread mapping)
- GitHub repository mapping
- branch/commit/PR context
- requirements and architecture state
- experiment/debug log extraction
- code/file relevance mapping
- implementation handoff between providers

## Sprint 6 - giant-chat replacement UX

- semantic chapters
- in-chat outline and jump navigation
- session rotation
- cross-provider timeline
- pins
- universal search
- one-click provider handoff

## Later

- project resource tags/collections, previews, notes, and link resources
- coding-tool adapters beyond the first validated implementation
- additional provider adapters
- packaged desktop installer and auto-update
- encrypted backups
- multi-device encrypted sync
- optional MCP/API interfaces
- optional critic/council workflows
