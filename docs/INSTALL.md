# Prototype 0.6 setup

Prototype 0.6 separates the application from your permanent AI workspace.

## Requirements

- Windows, macOS, or Linux with Node.js 22.5 or newer
- Chrome or Microsoft Edge
- Git if you want `git pull` updates

No provider API key is required for the current browser-companion workflow.

## Recommended Windows locations

Application checkout:

```text
%LOCALAPPDATA%\AI-Harness\app
```

Persistent data, created automatically:

```text
%USERPROFILE%\Documents\AI Harness
```

The second location contains Projects, Archive, Backups, and `harness.db`. It is not part of the Git repository.

## Start

From the application checkout, double-click `start-harness.cmd`, or run:

```bash
npm start
```

Open `http://127.0.0.1:4317/`.

## Browser companion

Chrome: `chrome://extensions`

Edge: `edge://extensions`

Enable Developer mode, choose **Load unpacked**, and select the application's `extension` folder. Refresh ChatGPT or Gemini.

A bright red **Harness ready** dot means the local service and browser companion can see one another. It does not mean every individual chat is safe to delete.

## Update the application

If this is a Git checkout, run `update-harness.cmd` or `update-harness.ps1`. It:

1. creates a clean SQLite backup under the persistent `Backups` folder;
2. runs `git pull --ff-only` on application source;
3. runs diagnostics.

Your project folders and archive are outside the Git checkout and are not replaced by the pull.

## Diagnostics

```bash
npm run doctor
```

## Manual backup

```bash
npm run backup
```

## First test

Follow `docs/TESTING.md`.
