# Resource Use Policy

When a Project Space is loaded into ChatGPT or Gemini, the model should use the resources that are relevant to the current task rather than relying only on a short summary.

Relevant resources can include:

- prior user prompts and reasoning
- prior ChatGPT and Gemini responses
- raw archived chat messages
- project files and PDFs
- images/screenshots
- code and documents in the project folder
- native provider tools
- current web information when useful

Prior model responses are working material, not authoritative sources.

## Scaling

If the full Project Space fits, use the relevant originals directly.

If it does not fit:

1. inspect the project/resource manifest
2. retrieve the most relevant prior chats/files
3. expand retrieval as needed
4. preserve provenance

Never permanently replace source material with a summary simply because the context window is limited.

## Critical-thinking boundary

The Harness should make AI more useful for productivity and learning, but it should not force a tutoring mode or a development mode. The model should follow the user's task and requests while keeping assumptions, uncertainty, and important tradeoffs visible enough for the user to exercise judgment.
