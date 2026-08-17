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
└── .harness\
    ├── derived\              # bounded temporary rebuild workspace; cleaned
    ├── context-sessions\     # private local-agent session support
    └── staging\              # imports/runtime staging
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

`workspace_resources` is the stable logical identity. Filesystem resources normally use `(root, relative path)`; high-confidence same-root file identity preserves that logical row across a rename. Provider/clipboard resources use generated archive paths while retaining their original displayed filename and origin JSON. `resource_versions` is immutable bytes/metadata identified by SHA-256. `current_version_id` selects current truth; old versions remain in the vault and are excluded from normal retrieval. Deletion marks the logical resource deleted without removing historical versions.

Every version has immutable `resource_representations` rows. Originals use an authoritative-original trust class. Text/code use digital-text representations. PDFs may have metadata, per-page digital text, rendered page images, embedded images, and per-page OCR artifacts. PNG/JPEG/WebP visuals retain the original and attempt OCR. OCR chunks carry page/region/confidence and an untrusted-derived authority. Office files remain explicit attachment-only resources in 0.8.0.

Derived bytes are content-addressed in the private vault and can be rebuilt from an authoritative original. Processing scratch directories live only under private `.harness\derived` and are removed after success or failure. No database, vault blob, OCR output, rendered page, token, or backup belongs in Git.

Captured user attachments, clipboard images, and provider-generated files enter the same resource/version/representation model through an internal content-addressed provider-archive root. Source types and relationships preserve user-input versus generated-output authority, provider/surface/session/message/native-asset origin, and capture method. That internal root is not a filesystem permission and cannot be removed or opened through root policy controls. It does not dirty the project repository. Explicit save-copy export writes exact current bytes only to a selected approved non-archive root and retains the source relationship.

`root_manifest_entries` persists high-resolution metadata, file identity, SHA-256, and resource/version linkage for deterministic delta verification. `context_draft_cache` is rebuildable, expires after ten minutes, and is invalidated by corpus/index/chat/instruction/personalization/surface identity. `session_context_ledgers` is an optimization record, never an original source. `resource_relationships` retains attachment, generation, and saved-copy edges. `context_prepare_metrics` retains stage timing diagnostics. These tables can be discarded/rebuilt without deleting original project or archive bytes.

## Snapshots and audits

`project_snapshots` stores the exact root/repository/generation/security evidence used by a preparation. `workspace_state` is a compact rebuildable current-state view. `outgoing_context_runs` and `outgoing_context_sources` record sanitized transmitted context, hashes, exclusions, attachment versions, scores, provenance, diagnostics, and blocked reasons. Raw detected secrets are not copied into security findings.

`instruction_versions` and `personalization_versions` preserve immutable configuration history. `agent_context_sessions` stores only token hashes, scope/capabilities, expiry, use, and revocation. `background_jobs` stores fixed job type, target, progress, status, and sanitized result/error metadata.

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
