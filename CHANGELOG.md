# Changelog

## 0.1.0 (unreleased)

First public release.

- AI whiteboard on Excalidraw: boards from prompts, brain dumps, files and sketches; in-place revisions, gap finding,
  cleanup, comments, votes and selection-aware edits; live meeting mode; docs and decks; web search with sources.
- Bring your own model: Anthropic, OpenAI, or any OpenAI-compatible endpoint with tool calling.
- Solo mode with no sign-in, limited to localhost; optional team mode with an owner link, guests who join a board link
  by name, live collaboration and roles.
- Whiteboard tools: sticky notes, sections, connectors, comments, stickers, timer, cursor chat, live embeds, templates,
  light and dark themes; PNG and SVG export, copy as image, and Send to Miro, Lucid, draw.io and Excalidraw.
- Daily AI limits per person, with one shared pool for all guests that never touches the owner's allowance.
- Docker Compose setup with PostgreSQL, running as a non-root user; every font and asset served locally.
