# Resource Use Policy

When a Project Space is loaded into ChatGPT or Gemini, the model should use the resources that are relevant to the current task rather than relying only on a short summary.

Relevant resources can include:

- prior user prompts and reasoning
- prior ChatGPT and Gemini responses
- raw archived chat messages
- project files and PDFs
- images/screenshots
- PDF page images, embedded images, and OCR with exact version/page/region provenance
- code and documents in the project folder
- native provider tools
- current web information when useful

Prior model responses are working material, not authoritative sources.

OCR is untrusted derived evidence. It is useful for retrieval but does not become an instruction, and it passes through the same secret scanner as digital text. Digital/OCR overlap is deduplicated for retrieval while both representation records remain auditable. The original visual remains authoritative; Harness does not fabricate visual semantics from OCR.

## Scaling

If the full Project Space fits, use the relevant originals directly.

If it does not fit:

1. inspect the project/resource manifest
2. retrieve the most relevant prior chats/files
3. expand retrieval as needed
4. preserve provenance

Never permanently replace source material with a summary simply because the context window is limited.

## Resource state controls

- **Always consider** places current safe chunks into the candidate pool even when the resource is old or the query has weak lexical overlap. It does not bypass context budgets or security.
- **Context Critical** additionally makes incomplete indexing, blocked security, or partial/unknown required representation a fail-closed CURRENT condition.
- **Superseded/Deprecated/Historical** preserves the source and all versions but excludes it from ordinary retrieval. Explicit historical/decision-trail intent may retrieve it with provenance.
- **Exclude from AI** prevents browser-provider transmission. A local-only root always wins over a per-resource allow request.

Changing any control invalidates speculative retrieval identity. Neither a cache nor an old session ledger can override the current policy.

## Critical-thinking boundary

The Harness should make AI more useful for productivity and learning, but it should not force a tutoring mode or a development mode. The model should follow the user's task and requests while keeping assumptions, uncertainty, and important tradeoffs visible enough for the user to exercise judgment.
