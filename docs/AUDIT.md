# Licenses and checks

A summary of what Monet Blackboard ships and how it was checked. CI repeats the automated checks on every pull request
and push.

## Licenses

- **Monet Blackboard** is licensed under Apache-2.0 (`LICENSE`, `NOTICE`).
- **The canvas** is `@excalidraw/excalidraw` 0.18.1 from npm, MIT licensed. Its full license text is in `NOTICE`. The
  build rewrites one URL in its bundle (the font fallback, from the esm.sh CDN to this server); nothing else is changed.
- **Fonts.** The app serves Excalidraw's fonts and Inter from its own origin. Excalifont, Virgil, Nunito, Lilita One,
  Assistant, Cascadia Code, Liberation Sans, Xiaolai and Inter are under the SIL Open Font License 1.1; Comic Shanns is
  MIT. Each font's copyright and full license text is in `licenses/fonts/`, and `NOTICE` lists them. The font files are
  redistributed unmodified, bundled with software as OFL 1.1 allows.
- **UI components** in `apps/web/src/components/ui/`, plus `hooks/use-toast.ts`, `hooks/use-mobile.tsx` and
  `lib/utils.ts` in `apps/web/src/`, started from shadcn/ui (MIT, `licenses/shadcn-ui.txt`).
- **Dependencies.** Every package that ships in the server or the web app is listed with its license in
  `THIRD_PARTY_LICENSES.md` (472 packages). All are permissive: MIT, ISC, Apache-2.0, BSD-3-Clause, 0BSD, Unlicense,
  CC0-1.0, (MIT AND Zlib), and OFL-1.1 for Inter. Three need a note:
  - `jszip` is "MIT OR GPL-3.0-or-later" and is used under MIT.
  - `dompurify` is "MPL-2.0 OR Apache-2.0" and is used under Apache-2.0.
  - `khroma` declares no license in `package.json`; its bundled license file is MIT.
    Nothing is GPL-only, LGPL, AGPL, SSPL or BUSL.
- **Code and assets.** No third-party source is vendored besides the adapted shadcn/ui files listed above. The logo, icons
  and Open Graph image were made for this project.

## Checks

| Check                                            | Command                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Known vulnerabilities in production dependencies | `pnpm audit --prod`                                              |
| Licenses of shipped packages                     | `pnpm licenses list --prod`                                      |
| Secrets in the tree and history                  | `gitleaks git --redact .`                                        |
| Formatting, types, unit tests, build             | `pnpm format:check && pnpm typecheck && pnpm test && pnpm build` |
| Every flow in real browsers, two people at once  | `pnpm test:e2e` (see `scripts/e2e/README.md`)                    |
| Security regressions over HTTP and WebSocket     | `node scripts/e2e/security-api.mjs`                              |
| The board AI on a real model                     | `node apps/server/test/ai-capabilities.mjs`                      |
| Docker quick start                               | `docker compose up -d --build`                                   |

Before the first release, all of these passed. The 25 real-model scenarios passed on both Anthropic
(`claude-sonnet-5-5`) and OpenAI (`gpt-6.2-sol`), and the core scenarios on an OpenAI-compatible endpoint.

The only key-like values in the repository are placeholders (`sk-ci-placeholder`) and test tokens
(`e2e-owner-token`, `sec-owner-token`) used by CI and the test suites.

## Security design

`SECURITY.md` describes the full model. In short:

- **Solo mode:** no sign-in, bound to `127.0.0.1`, and only requests addressed to localhost are answered, which blocks
  DNS rebinding.
- **Team mode:** an owner link (random token in the URL fragment, rate-limited, constant-time compare), guests created
  only through a working share link, server-side sessions in `HttpOnly` cookies, and access re-checked on live
  connections whenever sharing changes.
- **Both modes:** JSON-only writes from the app's own origin, strict security headers and page policy, no CDNs,
  server-side validation of every board element, sealed frames for live embeds, and rate limits on the API, uploads,
  WebSocket traffic and AI use.
