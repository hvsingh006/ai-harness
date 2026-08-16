# Prototype setup

Normal use is intended to become installer-driven. Prototype 0.3 still uses an unpacked browser extension.

## Requirements

- Windows, macOS, or Linux with Node.js 22.5 or newer
- Chrome or Microsoft Edge
- native ChatGPT, Gemini, and/or NotebookLM accounts as desired

No provider API key is required for the current browser-companion workflow.

## Start the local harness

From the repository folder:

```bash
npm start
```

Open `http://127.0.0.1:4317/`.

## Install the browser companion

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the repository's `extension` folder.

### Edge

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the repository's `extension` folder.

Then open or refresh ChatGPT, Gemini, or NotebookLM.

## Ready indicator

The local app deliberately uses a **bright red dot** beside **Harness ready** once the local service is running and a browser companion has checked in.

Before the companion is detected the same location says **Install/open companion** and the dot remains neutral.

The provider page companion also uses the bright red dot when connected.

## Extension upgrades

During prototype development, after the `extension` folder changes:

1. Open the browser extensions page.
2. Press **Reload** on AI Harness Companion.
3. Refresh the ChatGPT/Gemini/NotebookLM tab.

A packaged installer/update path should replace these steps before a stable release.
