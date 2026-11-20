# Security policy

## Reporting vulnerabilities

Please don't post exploitable details, credentials or personal data in public issues. Use the repository's
**Security → Report a vulnerability** private advisory feature. If private reporting isn't available, contact a
maintainer privately to arrange a secure channel first. There is no guaranteed response time; track the latest release.

## How Monet Blackboard is meant to run

### Solo mode (default)

Solo mode is for **one person on their own computer**. It has no sign-in, so anyone who can reach its port controls
every board and spends your AI key.

- It listens on `127.0.0.1` by default and warns at startup if `HOST` is set to anything else. `docker-compose.yml`
  publishes the port on `127.0.0.1` only.
- Pages, the API and the board WebSocket answer only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`.
  This stops DNS-rebinding pages from reaching the server through a hostname they control.
- Sharing links and guests are turned off.

### Team mode (`TEAM_MODE=1`)

Team mode lets other people join boards through links, so the server can face a network.

- **The owner** is whoever opens the owner link printed at startup. Its token (192 random bits) is stored in the
  database, travels in the URL fragment so it never reaches server or proxy logs, and is compared in constant time.
  Wrong guesses are rate-limited per IP. `OWNER_LINK_ROTATE=1` replaces it and ends every owner session.
- **Guests** are created only by entering a name on a working share link. They can't create or duplicate boards, and
  can only open boards they joined. A link carries one role (view or edit); the owner can change each person's role
  or remove them. A role the owner set decides that person's access even when a link would give more. Remove blocks
  that browser. To keep someone out for sure, reset the link: anyone who still has the old link can join again as a
  new guest, for example from a private window. Turning a link off or resetting it removes everyone who joined through it
  and closes their live connections; roles the owner set by hand stay until the owner removes the person.
- **Commenters** can add, edit and delete only their own comment pins (small pins with comment text), nothing else.
- **Sessions** are random 256-bit ids in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` whenever the request arrived
  over HTTPS (directly or through a trusted proxy). Sessions are stored server-side and revoked on sign-out. Live
  connections re-check access every minute and immediately when sharing changes.
- **Guest AI use** is capped per guest per day, per IP per hour, and in one daily pool shared by all guests, which
  never touches the owner's allowance. New guest identities are rate-limited per IP and per link, so minting guests
  doesn't add allowance. `GUEST_AI=0` turns guest AI off.
- **Strict limits** apply unless `NODE_ENV` is `development` or `test`. The scripted test model (`AI_MOCK`) and
  stubbed docs (`OUTPUTS_AI_STUB`) only work in those modes.
- Run team mode behind HTTPS (a tunnel or a reverse proxy; see the README). Set `PUBLIC_URL` to the address people
  use, and `TRUST_PROXY` if the proxy isn't on loopback or a private network. Rate limits use the client address
  that `TRUST_PROXY` allows, so a client can't pick its own by sending `X-Forwarded-For`.

### In both modes

- **Cross-site requests.** Changes (POST, PUT, PATCH, DELETE) are accepted only as JSON from this server's own origin
  (or `PUBLIC_URL` / `ALLOWED_ORIGINS`). Foreign or `null` origins, `Sec-Fetch-Site: cross-site`, form posts and
  `text/plain` bodies are refused. No CORS headers are ever sent. WebSocket handshakes from other origins are refused.
- **Headers.** The API sends `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and same-origin resource and opener policies. The web
  app has its own policy: scripts, fonts, images and connections only from this server (images also as data URLs),
  no CDNs, and frames only from the live-embed runner and three video sites (YouTube, Vimeo, Loom). Link cards don't
  fetch anything from the linked site, and images in AI-written docs and chat show as links.
- **Board content.** Element JSON from people and from the AI is validated on the server: unknown element types and
  malformed elements are dropped, `javascript:` and other unsafe links are removed, and images must be real image data
  URLs of an allowed type. Boards are limited to 800 items and 2 MB. Strings are cleaned so they can always be stored.
- **Live embeds** (polls, timers, calculators and AI-made prototypes) run in a sandboxed frame with an opaque origin and
  a policy that blocks every network request. Board state reaches the frame only over a private message port, so a
  page the embed navigates to never receives it, and messages from anywhere else are ignored.
- **Limits.** Request bodies are capped (32 KB for sign-in and for anyone without a session, 16 MB for boards and
  images, 1 MB elsewhere), JSON nested more than 64 levels is refused, and compressed request bodies are refused.
  Board sockets without a session can send only small frames until they join a board. Element versions that jump
  far ahead (which would freeze an element) are refused. Per-IP and per-person rate limits cover the API, board creation, uploads and AI
  requests. WebSocket messages are limited in size, rate, elements per message and sockets per person and per IP.
- **Your API key** stays on the server. Model output is treated as data: the AI changes the board only through tools
  whose arguments are validated, and it can't read other boards.
- **Miro and Lucid tokens** you paste into "Send to" are used for that one request and are never stored or logged.

## Your responsibilities

- Keep your API key in `.env` (never commit it) and set a spend limit with your provider.
- Keep solo mode on localhost. Use team mode, behind HTTPS, if anyone else needs access.
- Keep the owner link private. Anyone with it can manage every board.
- Prompt injection is an open problem. Files, web pages and board content the AI reads can try to steer it. The worst
  a steered AI can do is change the board it's working on (which undo reverses) and spend your AI budget; it has no
  access to other boards, your files or your network.
- `AI_MOCK=1` and `OUTPUTS_AI_STUB=1` are for testing and only work with `NODE_ENV=development` or `test`.
