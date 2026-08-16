# Architecture

## Core rule

**Chats are disposable. Workspaces are durable. Originals are authoritative. Derived context is replaceable.**

## Layers

```text
Native ChatGPT / Gemini / NotebookLM / future provider
                  |
          Browser companion
                  |
        Local AI Harness service
        /          |          \
Lossless vault  Working state  Search/index
        \          |          /
              Workspace
```

## Lossless archive

The archive is the canonical preservation layer.

### Raw records

`imports` records whole provider-export ingest jobs. Every file in an imported directory is copied into the local content-addressed vault before parsing.

### Messages

`messages` stores normalized text plus raw provider JSON/DOM payloads and provider identifiers. Sessions retain provider URLs and external IDs.

### Artifacts

`artifacts` stores exact copied bytes with SHA-256, MIME type, original path/source URL, provider, and metadata. The content-addressed vault avoids duplicate byte copies while preserving provenance records.

### Live asset references

`session_assets` tracks files/images discovered in native pages before their bytes are mirrored. A session with unmirrored references is not safe to delete.

## Derived state

Derived state can be regenerated from the archive:

- memories
- decisions
- workspace tasks
- learning state
- development state
- session summaries
- context packets

Every important derived item should eventually carry provenance back to raw messages or artifacts.

## Capture integrity

Required stages:

1. `raw_transcript`
2. `attachments`
3. `derived_state`
4. `search_index`

Only all four complete means `safe_to_delete`.

The current browser companion saves best-effort loaded-page snapshots and therefore does not claim `raw_transcript` completeness.

## Context compiler

A context packet should be compact enough for fresh sessions and provider handoff. It includes:

- workspace identity and current focus
- collaboration policy
- next actions
- durable memories
- recent session summaries/status
- learning state
- development state
- decisions
- file index
- archive manifest

The full archive is searched on demand rather than injected wholesale into every prompt.

## Active-learning policy

Learning context should tell native models to preserve productive struggle where appropriate. The harness tracks attempts and demonstrated mastery rather than treating AI-generated explanations as evidence that a concept is learned.

## Provider adapters

Adapters are replaceable boundary code. A provider website redesign should not affect archive or workspace data. Browser automation is considered fragile by design and isolated from the core.

## NotebookLM / Gemini

NotebookLM and Gemini notebook features remain native. The harness will map notebooks and source inventories into workspaces rather than recreate notebook functionality. Provider-specific sync is treated as an optimization, not canonical storage.

## Application / workspace separation

Application source and persistent user data are physically separate. The source checkout may be replaced or updated without touching Projects, Archive, Backups, or `harness.db`. Managed Project Spaces are normal filesystem directories; the immutable archive vault is a separate preservation layer. See `STORAGE.md`.

## Local-first

Prototype stack:

- Node.js 22+
- built-in `node:sqlite`
- local HTTP service on `127.0.0.1`
- static local dashboard
- Manifest V3 browser companion
- content-addressed local vault

A packaged desktop shell can be added after the core workflow stabilizes.

## Provider chat identity

Harness `sessions.id` is the immutable internal identity. Provider-native identifiers live in `session_external_refs`, allowing one session to retain a ChatGPT/Gemini chat ID, native URL, route, import/export identifier, and future provider-specific references without coupling the core schema to one vendor. See `CHAT_IDENTITY.md`.

## Resource retrieval

The archive is intentionally larger than a model context window may be. The context compiler provides working state and a resource manifest, while retrieval selects original messages/artifacts as needed. Scaling down means reducing active context, never deleting canonical history. See `RESOURCE_POLICY.md`.

## Readiness signal

Browser companions send a local heartbeat. `/api/readiness` reports whether the native-browser workflow has been seen. The dashboard uses the requested bright red dot only when the companion has checked in.
