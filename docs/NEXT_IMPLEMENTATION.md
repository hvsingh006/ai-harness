# Next implementation milestone: live-provider reliability validation

The local pre-trial hardening pass is complete. Do not add more provider integrations, modes, or dashboards before the external trial gate. The next work is live compatibility validation against signed-in ChatGPT and Gemini using the checklist in `docs/PRETRIAL_ACCEPTANCE.md`, followed only by narrow selector/event/attachment fixes supported by observed evidence.

The verified-current/security architecture is implemented. The next work is operational validation against provider behavior that local automated tests cannot fully simulate.

## Priorities

1. Run long, lazy-loaded ChatGPT and Gemini conversations through progressive capture. Preserve adapter evidence and keep uncertain histories partial.
2. Capture sanitized fixtures only when a live provider layout differs from the automated primary/alternate/hidden/empty/streaming fixtures already in the suite.
3. Exercise click, Enter, Shift+Enter, rapid repeat clicks, provider streaming states, route changes, provider acceptance, and attachment confirmation in real Chrome/Edge sessions.
4. Validate visible-chat recovery and provider-export reconciliation for conversations created while Harness/companion was inactive, without fabricating completeness.
5. Measure unchanged and changed prepare-send timing on large real repositories; optimize background queues without weakening full pre-send proof.
6. Validate installer remediation and retry recovery for the selected Poppler `pdftotext` dependency on a clean Windows installation.

## Non-negotiable gate

Do not weaken `Project Current`: if any required current source/index/repository/chat/security condition cannot be proven, normal managed send stays blocked. Do not turn provider limitations into silent cached-context fallback.

Do not add providers, product modes, decorative dashboards, a replacement chat interface, or broad coding-agent permissions during this validation milestone.
