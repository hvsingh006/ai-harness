# Next implementation milestone: context integrity and security

This is the next engineering scope. Do not expand provider count or add unrelated UI before these invariants are demonstrated.

## Product guarantee

When AI Harness shows a Project Space as current, a Harness-managed send from native ChatGPT or Gemini must be generated from a verified-current Project Space snapshot. If freshness cannot be verified, guaranteed mode fails closed rather than silently using stale state.

The user should add/link a file, folder, repository, chat, image, or result to a Project Space once. Harness owns change detection, current-version indexing, cross-chat continuity, and cross-provider continuity after that.

## 1. Reliable native ChatGPT and Gemini capture
- Detect complete versus partial/lazy-loaded transcripts.
- Capture through the latest visible/native message before a managed send.
- Reconcile reopened native chat IDs and imported/live sessions.
- Never mark a partial capture complete.

## 2. Verified-current Project Space index and retrieval
- Watch linked sources for changes, but do not rely on watchers alone.
- Add a mandatory pre-send freshness barrier that verifies current file versions/hashes and index generation.
- Search retained user prompts, ChatGPT responses, Gemini responses, documents, PDFs, images/results, project notes, and repository content.
- Maintain a compact current-working-state layer plus query-specific evidence retrieval.
- Preserve complete history even when only a subset fits the provider context window.

## 3. Repository and linked-root understanding
- Support multiple explicitly approved roots per Project Space.
- Keep repositories in their canonical filesystem locations.
- Track branch, HEAD, dirty state, changed files, repository structure, and relevant code relationships.
- Re-index changed files automatically; no repeated manual uploads.

## 4. Documents, images, attachments, and results
- Preserve current versions and archive prior versions with hashes/provenance.
- Extract/index documents and PDFs.
- Preserve and retrieve images/results with source associations.
- Where the provider needs a binary/native attachment, automate attachment from the Project Space when technically possible; manual file browsing must not be the normal workflow.

## 5. Native pre-send continuity
- The Send button remains the normal native ChatGPT/Gemini Send button.
- The companion coordinates with Harness before a managed send.
- Verify freshness, retrieve context, apply security policy, inject/attach context, then allow native send.
- New ChatGPT chats can use relevant Gemini history and vice versa.
- Harness should still capture/associate directly opened provider chats when the service/companion is available.

## 6. Security integrity
- Explicit allowlisted filesystem roots only; canonicalize and block path traversal/symlink escapes.
- Browser companion/cloud providers never receive arbitrary filesystem, shell, Git-credential, SSH-key, or browser-profile capability.
- Add authenticated localhost API/session tokens and strict origin/CORS/request validation.
- Default-deny secret files and scan outgoing content for keys/tokens/passwords/private keys/connection strings.
- Treat retrieved documents, code comments, webpages, old AI responses, and other corpus content as untrusted data, not permission-granting instructions.
- Keep cloud ChatGPT/Gemini effectively read-only. Local coding agents use separate scoped permissions.
- Record outgoing context provenance/audit data.

## Acceptance test
Over several days, alternate between native ChatGPT and Gemini, update documents and repository files, add images/results, start new chats directly and through Harness, then ask a fresh provider conversation to continue the work. It must use the latest verified project state and relevant historical decisions without manual re-upload/reconstruction. If required state cannot be verified current, guaranteed mode must visibly refuse to claim current context.
