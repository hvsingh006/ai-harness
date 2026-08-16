# Persistent storage model

AI Harness 0.6 separates application code from user data.

## Default Windows layout

```text
%LOCALAPPDATA%\AI-Harness\app\        # recommended Git checkout / application

%USERPROFILE%\Documents\AI Harness\  # persistent workspace root
├── Projects\
├── Library\
├── Archive\
│   ├── Vault\
│   └── Imports\
├── Backups\
├── .harness\                         # runtime staging only
└── harness.db
```

The application checkout can be deleted, replaced, recloned, or updated with `git pull` without deleting the persistent workspace root.

## Managed project folders

Creating a Project Space creates a normal directory under `Projects/`. Files dragged into the Harness are written to that directory. They remain ordinary user-visible files that can also be opened in Explorer, VS Code, or other applications.

The Harness separately creates immutable archive snapshots when files enter an AI workflow. The project filesystem and archive vault serve different purposes:

- **Project filesystem:** current human-facing working files.
- **Archive vault:** preserved historical source bytes and chat/provider assets.

## Existing folders

A Project Space can be pointed at an existing folder. The Harness records the path and indexes it in place. It does not move or delete the folder.

## Updates

`update-harness.ps1` performs a Harness database backup before `git pull --ff-only` and then runs diagnostics. Git only changes application source. Project folders and the archive are external.

## Legacy 0.5 migration

On first normal startup, if the new external `harness.db` does not exist but the old application-local `data/harness.db` does, 0.6 migrates it into the persistent workspace root and creates a backup of the legacy data. Artifact vault paths are reconciled to the new archive vault.

## Override

Set `HARNESS_WORKSPACE_ROOT` to use a different persistent location. The Harness rejects a workspace root inside the application checkout because that would defeat update isolation.
