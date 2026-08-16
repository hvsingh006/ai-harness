# Next implementation milestone: live-provider reliability validation

The verified-current/security architecture is implemented. The next work is operational validation against provider behavior that local automated tests cannot fully simulate.

## Priorities

1. Run long, lazy-loaded ChatGPT and Gemini conversations through progressive capture. Preserve adapter evidence and keep uncertain histories partial.
2. Build sanitized DOM fixtures for current provider variants and regression-test message/composer/send/file selectors.
3. Exercise click, Enter, Shift+Enter, rapid repeat clicks, provider streaming states, route changes, and attachment confirmation in real Chrome/Edge sessions.
4. Add reconciliation workflows for conversations created while Harness/companion was inactive, using visible-chat recovery and provider exports without fabricating completeness.
5. Measure unchanged and changed prepare-send timing on large repositories; optimize background queues without weakening full pre-send proof.
6. Decide whether to bundle a maintained PDF extraction runtime so guaranteed PDF indexing does not depend on a separately installed `pdftotext` executable.

## Non-negotiable gate

Do not weaken `Project Current`: if any required current source/index/repository/chat/security condition cannot be proven, normal managed send stays blocked. Do not turn provider limitations into silent cached-context fallback.

Do not add providers, product modes, decorative dashboards, a replacement chat interface, or broad coding-agent permissions during this validation milestone.
