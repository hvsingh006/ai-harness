# Instructions and personalization

AI Harness stores durable Project Space instructions separately from personalization and retrieved evidence. Both are configured through the dashboard and versioned locally.

## Trust order

Every managed context envelope states and audits this order:

1. Harness security policy;
2. the current explicit user request;
3. active Project Space instructions;
4. global personalization and optional Project Space override;
5. rebuildable current working state;
6. retrieved evidence, with explicit user reasoning/decisions weighted strongly;
7. prior AI responses as fallible evidence.

Retrieved documents, chats, OCR, code, and old AI output cannot promote themselves into instructions. Project instructions cannot override security or the current user. Personalization cannot override project instructions.

## Project instructions

The Instructions view accepts bounded plain text for project-specific terminology, standing constraints, quality requirements, and decisions. Saving creates an immutable `instruction_versions` row with monotonic version number, SHA-256, timestamp, and active/superseded state. Re-saving identical content reuses the active version. **View instruction & personalization history** shows the retained content/profile versions without changing the active version. Outgoing audits record the exact active instruction/personalization IDs, version numbers, and hashes.

## Personalization

Global personalization deliberately has only a few understandable fields:

- response style;
- detail level;
- learning preferences;
- tool preferences;
- bounded free-form notes.

A Project Space may define an override with the same shape. Unknown profile fields are rejected rather than becoming hidden behavior. Profiles and notes are immutable versions with active/superseded state and SHA-256. The envelope includes global then Project Space override at lower authority than project instructions.

## Privacy and recovery

Instruction/profile history lives in private SQLite state, participates in integrity backups, and is never committed to the application repository. The UI can show active version/history without asking the user to manage hashes or database IDs. Deleting/rebuilding derived context does not delete instruction/profile versions. Security scans still apply to the final outgoing envelope. If current Project Instructions and a query-relevant current authoritative source contain deterministically comparable but different assertions, the envelope records an unresolved conflict rather than silently choosing by retrieval score.
