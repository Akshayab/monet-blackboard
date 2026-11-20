// Videos and links on the board. Videos (YouTube, Vimeo, Loom, and the other sites Excalidraw knows how
// to embed) play inline in an iframe; any other web address shows as a link card instead of an iframe,
// because most sites refuse to be framed and arbitrary framed pages are a phishing risk on shared boards.
import type { ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import { ExternalLink, Link2 } from 'lucide-react';
import { isLiveEmbed, LiveEmbedFrame } from './live-embeds/frame';

export type EmbedKind = 'youtube' | 'vimeo' | 'loom' | 'link';

export interface ParsedEmbed {
  url: string;
  kind: EmbedKind;
  label: string;
  width: number;
  height: number;
}

/** Sites Excalidraw embeds itself (it rewrites their links to embed URLs). */

function bareHost(u: URL) {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

export function toHttpUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u;
  } catch {
    return null;
  }
}

function loomId(u: URL): string | null {
  if (!/(^|\.)loom\.com$/.test(bareHost(u))) return null;
  const m = u.pathname.match(/^\/(?:share|embed)\/([a-zA-Z0-9]+)/);
  return m ? m[1]! : null;
}

export function parseEmbedUrl(raw: string): ParsedEmbed | null {
  const u = toHttpUrl(raw);
  if (!u) return null;
  const host = bareHost(u);
  const url = u.toString();
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    return { url, kind: 'youtube', label: 'YouTube video', width: 560, height: 315 };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    return { url, kind: 'vimeo', label: 'Vimeo video', width: 560, height: 315 };
  }
  const loom = loomId(u);
  if (loom) {
    return { url: `https://www.loom.com/share/${loom}`, kind: 'loom', label: 'Loom video', width: 560, height: 315 };
  }
  return { url, kind: 'link', label: 'Link', width: 380, height: 104 };
}

/** Accept any http(s) address as an embeddable; how it renders is decided in renderEmbeddable. */
export function validateEmbeddable(link: string): boolean | undefined {
  return toHttpUrl(link) ? true : undefined;
}

function LoomFrame({ id }: { id: string }) {
  return (
    <iframe
      className="excalidraw__embeddable"
      src={`https://www.loom.com/embed/${id}`}
      title="Loom video"
      allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
      style={{ width: '100%', height: '100%', border: 0 }}
    />
  );
}

function LinkCard({ url, dark }: { url: URL; dark: boolean }) {
  const host = bareHost(url);
  const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  return (
    <div
      data-testid="embed-link-card"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 18px',
        boxSizing: 'border-box',
        background: dark ? '#1f2125' : '#ffffff',
        color: dark ? '#e9ecef' : '#1e1e1e',
        fontFamily: 'Nunito, ui-sans-serif, system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          flex: 'none',
          borderRadius: 10,
          background: dark ? '#2c2f35' : '#f1f3f5',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {/* No favicon: fetching one would make every viewer contact a site someone else chose. */}
        <Link2 size={22} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{host}</div>
        <div style={{ fontSize: 13, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rest || url.toString()}</div>
      </div>
      <a
        href={url.toString()}
        target="_blank"
        rel="noopener noreferrer"
        title="Open link in a new tab"
        style={{
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          fontWeight: 600,
          padding: '6px 10px',
          borderRadius: 8,
          background: dark ? '#2c2f35' : '#f1f3f5',
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        Open <ExternalLink size={13} />
      </a>
    </div>
  );
}

export function renderEmbeddable(element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) {
  // Live embeds (polls, timers, calculators, prototypes) run in the sealed frame, see live-embeds/frame.tsx.
  if (isLiveEmbed(element)) return <LiveEmbedFrame element={element} />;
  const parsed = element.link ? parseEmbedUrl(element.link) : null;
  if (!parsed) return null;
  if (parsed.kind === 'loom') {
    const id = loomId(new URL(parsed.url));
    return id ? <LoomFrame id={id} /> : null;
  }
  if (parsed.kind === 'link') return <LinkCard url={new URL(parsed.url)} dark={appState.theme === 'dark'} />;
  // YouTube and Vimeo: Excalidraw's own iframe.
  return null;
}

/** Spread onto <Excalidraw> so every client (including collaborators) renders embeds the same way. */
export const embedProps: Pick<ExcalidrawProps, 'validateEmbeddable' | 'renderEmbeddable'> = {
  validateEmbeddable,
  renderEmbeddable,
};
