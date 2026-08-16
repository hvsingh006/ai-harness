# AI Harness Architecture

## Core model

```text
Project Space
├── normal project folder
├── retained chat history
├── compact project context
├── lossless archive
│
├── native ChatGPT chats
└── native Gemini chats
```

The Project Space is durable. Native chats are working surfaces that can be replaced without losing the project record.

## Storage separation

Application code and user data are physically separate.

Application checkout:

```text
%LOCALAPPDATA%\AI-Harness\app
```

Persistent workspace:

```text
%USERPROFILE%\Documents\AI Harness
```

The persistent workspace contains Projects, Library, Archive, Backups, and `harness.db`.

## Chat identity

Each captured chat receives an immutable Harness session ID plus provider references such as:

- provider: `chatgpt` or `gemini`
- provider chat ID when available
- route
- native URL
- first/last seen timestamps

URLs are locators, not the canonical identity.

## Archive and context

The archive keeps raw messages and source assets. Compact context is derived from the archive and can be regenerated.

A new chat should receive only the relevant subset of project state, while search/retrieval can expand into older raw history as needed.

## Browser companion

The Chrome/Edge extension currently supports only:

- `chatgpt.com`
- `gemini.google.com`

Responsibilities:

- identify the active provider chat
- attach it to the selected Project Space
- capture loaded messages and accessible asset references
- show the AIH project/chat label
- insert Project Space context into a fresh chat
- bring an archived chat back into a prompt

Provider-specific DOM logic should stay isolated so changes to either website do not affect the archive model.

## Project files

Managed Project Spaces use a real folder under `Projects/`. Existing folders can also be attached without moving them.

The database stores an index and metadata. It does not replace the human-visible filesystem.

## Expansion rule

Keep the initial product centered on ChatGPT, Gemini, Project Spaces, files, and chat continuity. Additional modes/tools may be considered later only if they solve a demonstrated user problem without making the base workflow harder to understand.
