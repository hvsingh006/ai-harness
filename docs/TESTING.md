# Prototype 0.6 testing

This milestone is for validating the core continuity workflow. Do not judge `safe_to_delete` yet unless the UI explicitly marks a session safe. Live browser capture is intentionally conservative.

## Before testing

1. Install Node.js 22.5 or newer.
2. From the repository, run `npm run doctor`.
3. On Windows, double-click `start-harness.cmd` (or run `npm start`).
4. Open Chrome or Edge extensions.
5. Enable Developer mode.
6. Load the repository's `extension/` folder as an unpacked extension.
7. Refresh ChatGPT, Gemini, and/or NotebookLM.
8. Open the Harness **Setup & Test** screen. A bright red **Harness ready** dot means the local service and companion are connected.

## Test A: verify update-safe storage

1. Open **Setup & Test** and confirm the persistent workspace root is outside the application checkout.
2. Create a disposable Project Space.
3. Confirm its project-folder path is under the persistent `Projects` directory.
4. Drop in a small file and use **Open folder** to confirm the file exists as a normal filesystem file.
5. Refresh the Harness and confirm the file remains indexed.

Pass condition: application source and project storage are visibly separate, and the file exists outside the source checkout.

## Test B: create a durable project space

1. Click **New project**.
2. Name it something disposable, such as `Harness smoke test`.
3. Add a current focus.
4. Drop in one small PDF, image, or text file.
5. Confirm the resource appears and opens from Project Space.

Pass condition: the project and file remain visible after refreshing the Harness dashboard.

## Test C: native ChatGPT capture

1. Open ChatGPT from Project Space.
2. Confirm the red `AIH` label and companion card appear.
3. Ask ChatGPT a short question that refers to the project focus.
4. Send at least one follow-up.
5. Wait about 15 seconds or press **Capture now**.
6. Return to Harness > Sessions.

Pass condition: the ChatGPT session appears with the expected provider, title, and message count.

## Test D: provider switch without restating the project

1. Open Gemini from the same Project Space.
2. In the companion, press **Insert workspace context**.
3. Ask Gemini: `What project am I working on, what is my current focus, and what resources are available?`

Pass condition: Gemini can identify the project and resource inventory from Harness context without you manually restating it.

This test validates workspace continuity. It does not yet guarantee that every historical transcript line or authenticated attachment is available to the second provider automatically.

## Test E: archived chat reuse

1. Return to the ChatGPT chat from Test B.
2. Press **Bring this chat into prompt** in the companion.
3. Confirm the archived-session context is inserted or copied.

Pass condition: the Harness resolves the existing provider chat ID to the same internal session rather than creating an unrelated duplicate.

## Test F: fresh session

1. Start a new ChatGPT or Gemini native chat.
2. Use **Insert workspace context**.
3. Ask a question that depends on the project state.

Pass condition: starting a new native conversation does not require reconstructing the project manually.

## What is not yet a pass/fail criterion

- automatic `safe_to_delete` for live chats
- perfect capture of lazy-loaded very long conversations
- every authenticated provider attachment
- automatic context insertion with zero clicks
- complete NotebookLM notebook-source inventory
- semantic chapter/jump navigation

These are the next reliability targets after the first real-world smoke test.

## If something fails

Run:

```bash
npm run doctor
```

Record:

- which provider/site failed
- whether the AIH red label appeared
- whether **Capture now** worked
- the Harness session status
- the browser version
- the output of `npm run doctor`

Do not include private conversation content unless it is necessary to reproduce the issue.
