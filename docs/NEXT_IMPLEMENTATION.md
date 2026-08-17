# Next implementation milestone: live-provider reliability validation

The local pre-trial hardening pass is complete. Do not add more provider integrations, modes, or dashboards before the external trial gate. The next work is live compatibility validation against signed-in ChatGPT and Gemini using the checklist in `docs/PRETRIAL_ACCEPTANCE.md`, followed only by narrow selector/event/attachment fixes supported by observed evidence.

The verified-current/security architecture is implemented. The next work is operational validation against provider behavior that local automated tests cannot fully simulate.

## Priorities

1. Run long, lazy-loaded ChatGPT and Gemini conversations through progressive capture. Preserve adapter evidence and keep uncertain histories partial.
2. Capture sanitized fixtures only when a live provider layout differs from the automated primary/alternate/hidden/empty/streaming fixtures already in the suite.
3. Exercise click, Enter, Shift+Enter, rapid repeat clicks, provider streaming states, route changes, provider acceptance, and attachment confirmation in real Chrome/Edge sessions.
4. Validate visible-chat recovery and provider-export reconciliation for conversations created while Harness/companion was inactive, without fabricating completeness.
5. Measure unchanged, one-file-delta, instruction-only, cross-surface, and cold-restart prepare timing on large real repositories. Validate the 500 ms median/1.5 s P95 target from recorded stage metrics without weakening the manifest/reconciliation barrier.
6. Exercise native ChatGPT/Gemini file input, drag/drop, clipboard images, external PDFs, late provider-message provenance, generated assets, and Save-copy export. Capture sanitized provider fixtures only where production behavior differs.
7. Validate clean-machine WinGet provisioning/discovery for all four Poppler tools plus Tesseract, then retry/rebuild from the Resource Library.
8. Walk the complete UI-only daily workflow (create space, native picker, policies, coverage, history, instructions, security, agents, backup, diagnostics, update status) without using CLI/API tools.

## Non-negotiable gate

Do not weaken `Project Current`: if any required current source/index/repository/chat/security condition cannot be proven, normal managed send stays blocked. Do not turn provider limitations into silent cached-context fallback.

Do not add providers, product modes, decorative dashboards, a replacement chat interface, or broad coding-agent permissions during this validation milestone.
