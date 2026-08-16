# Project Spaces

A Project Space is the durable unit of work in AI Harness.

It combines:

- a normal filesystem folder
- project files/resources
- retained ChatGPT history
- retained Gemini history
- current focus/context
- archive/search metadata

Managed projects live under the persistent `Projects` directory. Existing folders can be attached without being moved.

Files remain normal files that can be opened in Explorer, Office, VS Code, or other applications. They are not owned by a particular ChatGPT/Gemini chat and are not stored inside the application Git checkout.

The first UI intentionally does not ask whether a project is for learning, development, planning, research, or anything else. A Project Space can be used for any of those purposes without changing modes.
