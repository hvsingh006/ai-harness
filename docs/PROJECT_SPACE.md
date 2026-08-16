# Project Spaces

A Project Space is the durable authority for one body of work. It combines approved live roots, immutable resource versions, retained ChatGPT/Gemini history, current working state, retrieval, snapshots, and outgoing provenance.

## Normal use

Add or link project material once, then edit files normally on disk. Watchers mark/index changes in the background, and the mandatory native-send barrier reconciles real bytes again before a guaranteed send. The user does not re-upload revised text/code/PDF material or tell the model which version changed.

New managed spaces live under `%USERPROFILE%\Documents\AI Workspace\Projects`. Repositories and explicit linked folders may remain in their canonical location. Each root has independent required/indexed/provider-allowed policy. Local-only roots can participate in local state but cannot enter ChatGPT/Gemini context or attachments.

## Continuity

All capturable original messages remain retained. Fresh chats receive compact working state, recent continuity, and query-specific evidence rather than every historical byte. Retrieval spans user messages, ChatGPT, Gemini, decisions, tasks, current files, repository content, and PDFs. User reasoning and explicit decisions receive stronger weight than old assistant answers.

Uncaptured activity is never invented. Coverage stays `PARTIAL` or `UNKNOWN` until evidence/imports establish completeness.

## Integrity states

- **Project Current:** a specific managed-send snapshot verified every required source, current versions/index, repository observation, visible chat synchronization, matching generations, and active security policy.
- **Verifying Project:** reconciliation is in progress.
- **Context Stale:** a change was observed or no verified snapshot exists; the next managed send verifies again.
- **Context Blocked:** a required check failed. The native message remains in the composer and is not replayed.

`Harness ready` only means the local service and paired companion are connected. `safe_to_delete` only means every preservation stage for a provider chat is complete. Neither is a synonym for Project Current.

## Native interfaces

Discussion remains on chatgpt.com and gemini.google.com. The companion can associate directly opened chats with the explicitly active Project Space, reconnect known provider IDs, and reject a cross-workspace mismatch. AI Harness is not a chat frontend or IDE and does not grant browser providers filesystem, shell, or Git capabilities.
