# AI Harness setup

The Windows installer installs Git, GitHub CLI, Node.js 22.5+, the Poppler tool family (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`), and Tesseract OCR when missing. It records trusted tool locations when WinGet does not expose them on `PATH`. The AI Harness shortcut starts a hidden localhost background process from the canonical checkout; the dashboard can be closed afterward. Service logs are written under private Harness state.

After an extension update, reload the unpacked extension and refresh ChatGPT/Gemini. Readiness reports both service and companion protocol versions and shows `reload_required` on a mismatch.

## Canonical checkout

The normal Windows source/runtime checkout is:

```text
%USERPROFILE%\Documents\AI Workspace\Projects\ai-harness
```

Private state remains under `%USERPROFILE%\Documents\AI Harness`; managed live projects default to `%USERPROFILE%\Documents\AI Workspace\Projects`. The setup/update scripts preserve this separation and do not create a duplicate installed source tree.

Requires Node.js 22.5 or newer. The project has no npm runtime dependencies and intentionally has no `package-lock.json`; `.npmrc` prevents npm from recreating dependency-free lockfile noise. Run `npm run doctor`, then use `start-harness.cmd` or `npm start` and open `http://127.0.0.1:4317/`.

## Browser companion

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode and load this checkout's `extension/` folder unpacked.
3. Open Harness Setup and choose **Pair browser companion**.
4. Refresh native ChatGPT/Gemini.

`Harness ready` means the paired companion and service are connected. It does not mean a Project Space is current or a chat is safe to delete; those have separate indicators.

## Updates

Use `update-and-launch-harness.cmd`. It refuses a dirty `main`, backs up private metadata, fetches and fast-forwards only, validates, rolls source back on validation failure, and launches the same canonical checkout. If GitHub is unavailable it leaves source unchanged and can launch the current revision.
