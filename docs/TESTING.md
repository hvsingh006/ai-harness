# AI Harness 0.8 testing

The pre-trial acceptance matrix is maintained in `docs/PRETRIAL_ACCEPTANCE.md`. The suite includes synthetic provider DOM fixtures, exact native-send delivery binding, crash recovery, asset origin rules, updater/temp repositories, scoped local-agent context, advanced path/secret attacks, real Poppler/Tesseract hybrid/scanned PDF processing, OCR security, Office attachment-only behavior, provider-neutral surface planning, UI APIs, and real localhost HTTP integration. Multimodal tests skip only when the host genuinely lacks a required executable; `npm run doctor` reports each tool separately and the Windows installer remediates it.

Passing local tests is not evidence that live ChatGPT/Gemini DOM integration works. Live provider compatibility is a separate external gate.

## Automated gate

Run from the canonical repository:

```bash
npm test
npm run doctor
npm run dev:status
npm run test:clean   # after committing: clone HEAD and prove representative workflows leave it clean
```

The automated suite covers additive 0.7 migration, storage isolation, migration conflicts, path/symlink security, immutable source/representation versions, manifest fast paths and single-file deltas, rename continuity, current-only unified retrieval, real digital/OCR/page/embedded-image processing, on-demand exact-page materialization, OCR injection/secret filtering, binary/visual delivery security state, native user-input/provider-output ingestion, late message-provenance association, cross-provider clipboard OCR continuity, exact-hash reconciliation/ambiguous non-merge, safe project-folder export, surface capability/unknown-adapter failure, explicit page non-substitution, unrelated-heavy-document isolation, instructions/personalization trust order, speculative-cache invalidation, bounded session bootstrap/delta, always-consider/critical/superseded policy, scoped local context, bounded/recoverable jobs, UI APIs, chat preservation coverage, pairing/auth/origins, same-origin shutdown, outgoing audits, attachments, immediate disk changes, and unavailable-root HTTP 412 failure. Retrieval-quality tests also cover visible/alternate edited chat paths, current branch/worktree provenance, deterministic instruction/source conflicts, evidence-class budgets, and cross-workspace rejection by the optional semantic interface.

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

## Live test G: native input durability and cross-provider use

1. In an associated ChatGPT chat, paste a Snipping Tool image containing `CLOCK = 250 MHz` and send normally.
2. Confirm Resources shows **Pasted into ChatGPT**, the immutable current version, OCR coverage, and originating message provenance.
3. Close that conversation, open a new associated Gemini conversation, and ask what frequency appeared in the earlier screenshot.
4. Repeat with a PDF attached from Downloads, then ask about it from a new ChatGPT conversation.

Pass: no re-upload is needed; current OCR/PDF evidence and original bytes are available according to surface capability; history is not safe to delete before byte/derived/index stages complete; Downloads was not granted as a root; the Git worktree was not dirtied.

## Live test H: warm and changed latency

Inspect outgoing diagnostics after association prewarm, an unchanged send, a one-file edit, instruction-only change, and surface switch. Pass locally means unchanged sends hash/process zero files, one-file edits hash/process only that candidate, cache hits occur only under exact identity, instruction changes do not rerun source extraction, and any generation/policy/chat change invalidates the draft. Collect real P50/P95 numbers; do not claim the 500 ms/1.5 s target until measured on the user corpus and live provider surface.

## Known environment limitation

PDF processing uses locally installed Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`) and Tesseract. Missing minimum PDF processing or a failed required representation is never replaced with cached older data; coverage/freshness/delivery status stays explicit and visual-dependent delivery fails closed when no supported current fallback exists. Provider DOM and attachment behavior still require the live smoke tests above after browser/provider changes.
