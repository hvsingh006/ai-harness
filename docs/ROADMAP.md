# AI Harness Roadmap

## Current milestone: simple continuity prototype

Goal: prove that separate Project Spaces can retain files and chat history while the user moves between new ChatGPT and Gemini chats.

### Required

- [x] persistent storage outside the application checkout
- [x] multiple Project Spaces
- [x] normal project folders and drag/drop files
- [x] native ChatGPT launcher
- [x] native Gemini launcher
- [x] browser companion scaffolding
- [x] stable Harness session IDs and provider chat references
- [x] chat history view
- [x] archive search
- [x] context packet generation
- [x] light/dark/system appearance
- [ ] verify complete capture on real long ChatGPT conversations
- [ ] verify complete capture on real long Gemini conversations
- [ ] improve attachment/image preservation
- [ ] make provider switching reliable enough for daily use
- [ ] make fresh-chat context insertion low-friction

## Next milestone: reliability

- reconcile imported and live chat IDs
- detect lazy-loaded/partial transcripts
- improve safe-to-delete verification
- preserve authenticated attachments where technically possible
- improve recovery/backup UX
- add regression tests for provider DOM changes

## Later, only after continuity is reliable

- conversation outline and jump navigation for long chats
- better semantic retrieval over large Project Spaces
- richer file previews
- optional integrations that are justified by real usage

Do not add dedicated learning/development modes or additional AI providers merely because the architecture can support them.
