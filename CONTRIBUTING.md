# Contributing

Issues and pull requests are welcome. Please run the checks below before opening a PR.

By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](LICENSE), the same license
as the project (see section 5 of the license).

## Checks

```bash
pnpm format:check
pnpm typecheck
pnpm test        # unit tests in apps/server/test/unit; no database, network or API key needed
pnpm build
```

CI runs these on every pull request, plus the end-to-end suite and a Docker quick start. Add a unit test for changes
to the host and origin checks, sessions, sharing rules, rate limits or AI limits.

## Database changes

Edit `lib/db/src/schema/*.ts`, then generate a migration:

```bash
pnpm db:generate
```

Commit the new file in `lib/db/migrations/`. The server applies pending migrations when it starts.

## End-to-end tests

The Playwright suite in `scripts/e2e` drives real browsers through every flow: the owner link, guests, drawing,
realtime editing between two people, sharing and roles, comments, embeds, exports, the AI panel and color contrast.
It runs against a server in team mode with the scripted stand-in model, so it needs no API key:

```bash
pnpm build
TEAM_MODE=1 OWNER_LINK_TOKEN=e2e-owner-token NODE_ENV=development AI_MOCK=1 pnpm start
# in another terminal
pnpm --filter @monet/scripts exec playwright install chromium
pnpm test:e2e
```

See [scripts/e2e/README.md](scripts/e2e/README.md) for solo-mode specs, real-model specs and the other checks.

## The board AI

Prompt and tool changes affect every board, and models differ. Check them against a real model on both providers:

```bash
ANTHROPIC_API_KEY=... pnpm start
BASE=http://localhost:3000 node apps/server/test/ai-capabilities.mjs           # 25 scenarios
BASE=http://localhost:3000 ONLY=P1,F1 node apps/server/test/ai-capabilities.mjs
```

This spends API credits. Repeat with `OPENAI_API_KEY` and include the results in your PR.
