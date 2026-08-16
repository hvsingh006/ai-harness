# AI Harness Product Spec

## 0.8.0 deterministic native-send rule

`Project Current` and `sent` are separate claims. Project Current requires verified current sources/index/repository/chat/security. Sent additionally requires provider acceptance evidence tied to the exact prepared attempt. A click, composer mutation, timer, or optimistic API response is insufficient. Protocol mismatch, missing capability evidence, established-chat zero-message extraction, source mutation, uncertain attachment confirmation, or uncertain provider acceptance fails closed.

Office files are intentionally attachment-only in 0.8.0; no Office text-extraction claim is made. Images are immutable/current but have no OCR claim. These are capabilities, not silent degradation.

## Product goal

AI Harness is a local Project Space layer for using native ChatGPT and Gemini without losing continuity.

The core problem is simple: starting a new chat or switching between ChatGPT and Gemini should not mean starting over.

The Harness should improve productivity and learning while preserving the user's own judgment and critical thinking.

## First-version scope

Each Project Space has:

- a name and current focus
- a normal project folder containing files, PDFs, images, code, notes, and other resources
- retained ChatGPT and Gemini chat history
- stable links between native provider chat IDs and Harness sessions
- search across retained chat history
- a compact handoff context for a new native chat
- a lossless archive behind the compact context

The native ChatGPT and Gemini websites remain the chat interfaces.

## Primary workflows

### Continue in a new chat

1. Work normally in ChatGPT or Gemini.
2. The browser companion captures the conversation into the selected Project Space.
3. Start a fresh chat in either service.
4. Insert the Project Space context.
5. Continue without manually reconstructing prior work.

### Switch services

1. Work in ChatGPT.
2. Open Gemini from the same Project Space, or the reverse.
3. The new service receives the relevant project context, files/resource inventory, and prior chat state.
4. The original chat remains searchable and reopenable.

### Reuse old chats

The Chat History view should let the user:

- see chats associated with the current Project Space
- reopen the native ChatGPT/Gemini chat when its URL is available
- search raw retained messages
- bring an old chat back into a new prompt

### Project files

Project files live in a normal folder outside the application checkout. The Harness indexes them and can preserve immutable archive copies when needed. Updating the application must never replace project folders or chat history.

## Context and retention

The Harness keeps two layers:

1. Lossless source material: captured messages, imports, files/assets, provider IDs, URLs, and provenance.
2. Compact working context: current focus, relevant prior chats, useful memories/decisions, and resource inventory.

If the full project is too large for one model context window, the Harness should retrieve progressively relevant source material. It should not solve context limits by deleting history or treating summaries as the only truth.

## AI behavior

When project context is supplied, ChatGPT or Gemini should:

- use relevant prior user prompts and prior model responses
- use relevant project files, PDFs, images, and archived messages
- use native tools and current web information when useful
- avoid asking the user to restate information already present
- treat prior AI responses as fallible working material, not authority
- improve productivity and understanding without replacing the user's critical thinking

## UI

Keep the first UI small:

- Project Space
- Chat History
- Setup
- project selector
- New project
- Open ChatGPT
- Open Gemini
- Open both
- Inspect context / fresh session helpers
- light, dark, and system appearance

There are no Learning, Development, Direction, or provider-selection modes in the first UI. Those are use cases, not workspace types.

## Out of scope for the first version

- custom replacement chat UI
- additional AI providers
- autonomous multi-agent orchestration
- dedicated learning dashboards
- dedicated development dashboards
- coding-agent integrations
- complex knowledge graphs

The internal architecture may leave room for later expansion, but none of these should complicate the initial user experience.
