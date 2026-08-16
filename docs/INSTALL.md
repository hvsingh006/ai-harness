# Prototype 0.6.3 setup

AI Harness keeps the updateable application separate from your permanent Project Spaces and chat archive.

## Normal Windows use

After installation, use the **AI Harness** Desktop or Start Menu shortcut. It runs `update-and-launch-harness.cmd`, which:

1. checks `origin/main` for a newer version;
2. if an update exists, creates a SQLite backup first;
3. applies only a clean fast-forward update;
4. installs required Node dependencies;
5. runs diagnostics;
6. rolls the application source back to the prior revision if validation fails;
7. launches AI Harness.

If GitHub cannot be reached, the Update & Launch wrapper opens the currently installed version instead.

Application checkout:

```text
%LOCALAPPDATA%\AI-Harness\app
```

Persistent workspace:

```text
%USERPROFILE%\Documents\AI Harness
```

The persistent location contains Projects, Archive, Backups, and `harness.db`. It is not part of the Git repository.

## Browser companion

Chrome: `chrome://extensions`

Edge: `edge://extensions`

Enable Developer mode, choose **Load unpacked**, and select the application's `extension` folder. Refresh ChatGPT or Gemini.

A bright red **Harness ready** dot means the local service and browser companion can see one another. It does not mean every individual chat is safe to delete.

## Manual controls

Update without launching:

```text
update-harness.cmd
```

Launch without checking for updates:

```text
start-harness.cmd
```

Diagnostics:

```bash
npm run doctor
```

Manual backup:

```bash
npm run backup
```
