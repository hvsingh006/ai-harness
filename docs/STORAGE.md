# Persistent storage model

AI Harness 0.8 separates live project material, private continuity state, and application source.

## Defaults

```text
%USERPROFILE%\Documents\AI Workspace\Projects\
├── ai-harness\               # canonical Git checkout and runtime source
└── <managed Project Space>\  # live working files

%USERPROFILE%\Documents\AI Harness\
├── harness.db
├── Archive\
│   ├── Vault\blobs\         # content-addressed immutable bytes
│   └── Imports\
├── Backups\
├── Library\
└── .harness\                 # private credential, staging, runtime files
```

`HARNESS_WORKSPACE_ROOT` selects the private state root. `HARNESS_PROJECTS_ROOT` selects the managed live-project parent. An explicit `HARNESS_DB`/database path keeps portable/test projects beside that database unless `HARNESS_PROJECTS_ROOT` is also explicit.

The canonical repository and private Harness state must remain separate. Git never stores databases, provider exports, vault blobs, credentials, tokens, backups, or browser profiles.

## Multiple roots

`workspace_roots` records every approved source with canonical identity and independent policy:

- `primary`, `repository`, `linked_folder`, or `resources` label/kind;
- required or optional for freshness;
- indexing enabled or disabled;
- provider allowed or local only.

Kind is descriptive, not an authorization. Authorization comes from the explicit root record and canonical containment checks. Linked external folders stay where they are.

## Resources and versions

`workspace_resources` is the stable logical identity `(root, relative path)`. `resource_versions` is immutable bytes/metadata identified by SHA-256. `current_version_id` selects current truth; old versions remain in the vault and are excluded from normal retrieval. Deletion marks the logical resource deleted without removing historical versions.

Text/PDF extraction produces rebuildable `resource_chunks` plus SQLite FTS5 rows with line/page/version provenance. Binary/image resources retain truthful metadata even when no text exists.

## Snapshots and audits

`project_snapshots` stores the exact root/repository/generation/security evidence used by a preparation. `workspace_state` is a compact rebuildable current-state view. `outgoing_context_runs` and `outgoing_context_sources` record sanitized transmitted context, hashes, exclusions, attachment versions, scores, provenance, diagnostics, and blocked reasons. Raw detected secrets are not copied into security findings.

## Legacy managed-project migration

Older managed live folders under private `%USERPROFILE%\Documents\AI Harness\Projects` are migration candidates. Setup performs an explicit safe migration:

1. refuse attached external folders;
2. refuse an existing target conflict;
3. copy to a unique staging directory under the live projects parent;
4. compare file count/path/size/SHA-256 manifests;
5. rename the verified staging tree into place;
6. transactionally update workspace/root references and write a migration record;
7. retain the original source tree as a recoverable fallback.

The private archive/history is not moved or rewritten. No source tree is deleted automatically.
