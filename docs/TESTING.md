# AI Harness 0.8 testing

The pre-trial acceptance matrix is maintained in `docs/PRETRIAL_ACCEPTANCE.md`. The suite includes synthetic provider DOM fixtures, exact native-send delivery binding, crash recovery, asset origin rules, updater temp repositories, local-agent root scoping, advanced path/secret attacks, PDF recovery, Office attachment-only behavior, and real localhost HTTP integration. A skipped PDF retry case means the test process could not execute `pdftotext`; `npm run doctor` reports that condition separately and the installer remediates it.

Passing local tests is not evidence that live ChatGPT/Gemini DOM integration works. Live provider compatibility is a separate external gate.

## Automated gate

Run from the canonical repository:

```bash
npm test
npm run doctor
npm run dev:status
```

The automated suite covers additive 0.7 database migration, storage isolation, safe legacy-project migration/conflicts, approved-root traversal/symlink security, immutable versions, deletion/new-file discovery, current-version-only retrieval, ChatGPT/Gemini/user weighting, repository state, chat reconciliation/coverage, secret blocking/redaction, companion pairing/auth/origin rules, outgoing audit/envelope cleanup, opaque current attachments, immediate pre-send disk changes, and unavailable-root HTTP 412 failure.

## Required live smoke setup

1. Start Harness from the canonical checkout.
2. Load/reload `extension/` unpacked in Chrome or Edge.
3. Open `http://127.0.0.1:4317/`, go to Setup, and pair the companion.
4. Confirm **Harness ready**. This is connectivity only.
5. Choose a disposable Project Space with a required text file and, optionally, a Git repository.

## Live test A: current file without re-upload

1. Open native ChatGPT directly.
2. Ask a question that names the text file and press native Send.
3. Inspect the outgoing context in Harness and confirm the current version/hash/provenance.
4. Edit the file on disk without uploading or notifying the model.
5. Ask again in the same or a new native chat.

Pass: the second snapshot and context use the newest bytes/version. The old version remains archived but is not selected as current truth.

## Live test B: cross-provider/new-chat continuity

1. Record a user decision in ChatGPT.
2. Continue in Gemini and add contradictory/new reasoning.
3. Start a new ChatGPT chat directly and ask what to implement.

Pass: selected evidence includes relevant reasoning from both providers, later evidence/current files, clean provenance, and honest history coverage without manual reconstruction.

## Live test C: fail closed

1. Complete one successful managed send.
2. Rename or disconnect a required linked folder.
3. Press native Send again.

Pass: the user message remains intact, the native provider receives nothing, the companion shows `Context blocked`, HTTP preparation records `ROOT_UNAVAILABLE`, and the prior cached context is absent. Restore the root and retry; the new verification should succeed.

## Live test D: native interaction safety

Test ChatGPT and Gemini separately:

- click Send;
- Enter-to-send;
- Shift+Enter newline;
- double click / repeated Enter while preparing;
- route change to a new chat;
- provider response streaming state.

Pass: exactly one native message is sent after a successful preparation, no recursion/double-send occurs, and failure restores/preserves the original composer text.

## Live test E: long-history evidence

Use a long lazy-loaded conversation. Choose **Capture & reconcile now**, then inspect session evidence: reached top, stable rounds, message count/fingerprints, timestamps, and adapter version.

Pass: only evidence-backed captures become `COMPLETE`. Any uncertainty remains `PARTIAL`; `Project Current` may still describe current known sources but carries the coverage warning. Do not call a chat safe to delete until all preservation stages are complete.

## Live test F: attachment confirmation

Add an image once, then replace it on disk. Ask about its visual layout by name.

Pass: the current version is prepared by opaque ID, the provider UI visibly confirms the filename before Send replay, and audit provenance identifies the current hash/version. If the provider control cannot confirm attachment, the send remains paused and the run is audited as failed.

## Known environment limitation

PDF text extraction uses local `pdftotext`. A missing executable or failed required-PDF extraction must produce `RESOURCE_INDEX_FAILED`; it is not an acceptable reason to claim Current from a cached/empty index. Provider DOM and attachment behavior require the live smoke tests above after browser/provider changes.
