// Content Security Policy for the production page, shipped as a <meta> tag by vite.config.ts (the server adds
// frame-ancestors as a header, which a meta tag can't set). Dev skips it because Vite injects inline scripts.
// Excalidraw needs inline styles, wasm (font subsetting), blob: workers and images. Every font is served from this
// origin (Inter from @fontsource, Excalidraw's fonts copied into /fonts), so no CDN is allowed.

/**
 * The only pages the board may show in a frame: the live-embed runner (same origin, /embed-frame.html) and the three
 * video sites the board plays inline. Any other link renders as a link card. A frame can navigate itself, so allowing
 * every https page would let a live embed leave its sealed runner.
 */
export const EMBED_FRAME_SOURCES = ["'self'", 'https://www.youtube.com', 'https://player.vimeo.com', 'https://www.loom.com'];

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Board images are stored on this server as data URLs; nothing on the page loads images or media from elsewhere.
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  // 'self' covers the board's own WebSocket (ws:/wss: on this host).
  "connect-src 'self'",
  "worker-src 'self' blob:",
  `frame-src ${EMBED_FRAME_SOURCES.join(' ')}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
