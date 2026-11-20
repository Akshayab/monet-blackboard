# Monet Blackboard end-to-end tests

Playwright tests that drive the running app the way people do: the owner link, guests joining through
share links, real mouse and keyboard input on the canvas, and separate browser contexts for realtime checks.

## Run

Start a server in team mode with a pinned owner link and a generous development profile, then run the suite:

```bash
pnpm build
TEAM_MODE=1 OWNER_LINK_TOKEN=e2e-owner-token NODE_ENV=development AI_MOCK=1 pnpm start
# in another terminal
pnpm test:e2e                                          # everything
pnpm --filter @monet/scripts run e2e:api               # protocol checks only, no browser (~5 s)
pnpm --filter @monet/scripts run e2e realtime.spec.ts
```

`AI_MOCK=1` uses a scripted stand-in model, so no API key is needed and nothing is spent. Tests marked
"real model" skip themselves with the stand-in; start the server with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
instead of `AI_MOCK=1` to run them (they spend API credits).

Run `solo.spec.ts` against a server started **without** `TEAM_MODE`. In solo mode, specs that need guests skip
themselves, and in team mode `solo.spec.ts` skips itself.

Set `DATABASE_URL` to the server's database to enable the few checks that seed rows directly (usage limits,
doc and deck pages). They skip themselves otherwise.

| Env                   | Default                 | Meaning                                              |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| `E2E_BASE_URL`        | `http://localhost:3000` | App under test                                       |
| `E2E_OWNER_TOKEN`     | `e2e-owner-token`       | The server's `OWNER_LINK_TOKEN`                      |
| `E2E_WORKERS`         | 3                       | Parallel workers                                     |
| `E2E_RETRIES`         | 0                       | Retries (0 so flakiness shows)                       |
| `E2E_TRACE`           | off                     | `1` keeps traces for failed tests in `.output/`      |
| `E2E_LIVE_TIMEOUT_MS` | 5000                    | How long a change may take to reach the other person |
| `E2E_CHROMIUM_PATH`   | Playwright's Chromium   | A Chromium binary to use instead                     |

Install Playwright's Chromium once with `pnpm --filter @monet/scripts exec playwright install chromium`.

## Reports

Each run writes `scripts/e2e/.report/`: `summary.md` (counts plus one row per test, with skip reasons),
`results.json`, and `html/index.html` (screenshots attached to tests). Failure screenshots and traces go to
`scripts/e2e/.output/`. Both folders are ignored by Git.

## Specs

| Spec                  | Covers                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `auth.spec.ts`        | owner link (missing, wrong, right), guests joining by name, changing your name, dead links                               |
| `solo.spec.ts`        | solo mode: no sign-in, other host names refused (DNS rebinding), cross-site writes refused, Share dialog, no CDN         |
| `boards.spec.ts`      | Whiteboard tile, draw, rename, reload persistence, library, reopen, duplicate, delete, odd input                         |
| `canvas.spec.ts`      | pan and zoom, shapes, bound arrows, text, freehand, sections, selection, resize, colors, undo and redo, copy and paste   |
| `realtime.spec.ts`    | two people: live edits both ways, deletes, simultaneous edits, presence, live cursors, follow mode, live rename          |
| `sharing.spec.ts`     | view-only link, live updates for viewers, link off, the Share dialog, roles, removing a guest                            |
| `shell.spec.ts`       | board chrome, stickers, comments, cursor chat, timer, commenter role, link cards, light and dark mode, text fitting      |
| `inputs.spec.ts`      | images, files, embeds, sealed live widgets, calculator and other inputs                                                  |
| `features.spec.ts`    | library prompt to board, board tools, phone layout, layout fixes                                                         |
| `ai.spec.ts`          | usage limits, who may call the AI, daily and concurrent limits, AI elements live for two people, undo of a whole AI run  |
| `contrast.spec.ts`    | axe color contrast (WCAG 2.2 AA) on the pages before joining, the library and an open board, dark and light, phone width |
| `palette.spec.ts`     | no browser: sticky, text, arrow and presence colors reach AA in both themes                                              |
| `ws-protocol.spec.ts` | raw WebSocket clients: auth refusals, broadcast without echo, version rule, tombstones, read-only, persistence           |

Scripts outside Playwright:

- `security-api.mjs`: security regression checks over HTTP and WebSocket (see the header for the server flags).
- `ai-limits-check.mjs`, `rooms-check.mjs`: direct checks of the AI limits and the realtime rooms against a database.
- `embed-csp-check.mjs`: the production page policy blocks sealed embeds from navigating away.
- `apps/server/test/ai-capabilities.mjs` and `ai-stop-check.mjs`: real-model scenarios and the AI stop button.

## Writing tests

- Use `test` from `lib/fixtures.ts`. The `user` fixture makes the default context the owner. `newPerson(browser)` is
  the owner in another context; `newGuest(browser, name)` is someone who joins through a share link.
- `openBoard(page, url)` waits for the realtime `init` frame, so the board is live when it returns. On `/s/` links
  it fills in the guest name prompt.
- Read state with `sceneOf(page)` and `appStateOf(page)`. These read the Excalidraw component through a hook installed
  only in test browsers (`installSceneHook`); nothing is exposed in the production app. Check the server's copy with
  `getBoard(request, id)`, which reads the live room.
- Excalidraw handles keys only when the canvas has focus: call `focusCanvas(page)` after opening a board.
- Prefer `data-testid` selectors. Attach evidence with `snap(page, testInfo, name)`.
- Every browser test acts as the same owner, so don't rename the owner and free any AI run slots you hold.
