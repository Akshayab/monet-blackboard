// Markdown for AI chat messages, rendered with react-markdown + remark-gfm (tables, strikethrough,
// autolinks, task lists). Raw HTML is never rendered (react-markdown escapes it), and links only go to app
// paths, #anchors, http(s), and mailto. Internal links navigate inside the app.
import type { MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocation } from 'wouter';
import { cn } from '@/lib/utils';

/** Returns a safe href, or null if the URL shouldn't be linked. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#')) return url;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

/** Internal app paths keep the board's share-link token so link-joined people keep access. */
export function withLinkToken(href: string, linkToken: string | null | undefined) {
  if (!linkToken || !href.startsWith('/b/') || /[?&]link=/.test(href)) return href;
  return `${href}${href.includes('?') ? '&' : '?'}link=${encodeURIComponent(linkToken)}`;
}

export function useInternalNavigate() {
  const [, navigate] = useLocation();
  return (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!href.startsWith('/') || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
}

const urlTransform = (url: string) => safeHref(url) ?? '';

export function Markdown({ text, linkToken, className }: { text: string; linkToken?: string | null; className?: string }) {
  const nav = useInternalNavigate();
  const components: Components = {
    a: ({ node: _node, href, children }) => {
      if (!href) return <span>{children}</span>;
      const target = withLinkToken(href, linkToken);
      const internal = target.startsWith('/') || target.startsWith('#');
      return (
        <a
          href={target}
          onClick={(e) => nav(e, target)}
          className="font-medium text-[var(--monet-active-fg)] underline decoration-[var(--monet-active-fg)]/40 underline-offset-2 hover:decoration-[var(--monet-active-fg)]"
          {...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          data-testid="link-ai-message"
        >
          {children}
        </a>
      );
    },
    h1: ({ node: _node, ...p }) => <h3 className="font-sans text-[0.95rem] font-semibold text-[var(--monet-text-strong)]" {...p} />,
    h2: ({ node: _node, ...p }) => <h3 className="font-sans text-[0.95rem] font-semibold text-[var(--monet-text-strong)]" {...p} />,
    h3: ({ node: _node, ...p }) => <h4 className="font-sans text-sm font-semibold text-[var(--monet-text-strong)]" {...p} />,
    h4: ({ node: _node, ...p }) => <h4 className="font-sans text-sm font-semibold text-[var(--monet-text-strong)]" {...p} />,
    h5: ({ node: _node, ...p }) => <h4 className="font-sans text-sm font-semibold text-[var(--monet-text-strong)]" {...p} />,
    h6: ({ node: _node, ...p }) => <h4 className="font-sans text-sm font-semibold text-[var(--monet-text-strong)]" {...p} />,
    ul: ({ node: _node, ...p }) => <ul className="list-disc space-y-0.5 pl-5" {...p} />,
    ol: ({ node: _node, ...p }) => <ol className="list-decimal space-y-0.5 pl-5" {...p} />,
    blockquote: ({ node: _node, ...p }) => <blockquote className="border-l-2 border-[var(--monet-border-2)] pl-3 text-[var(--monet-text-faint)]" {...p} />,
    code: ({ node: _node, className: cls, ...p }) => (
      <code className={cn('rounded bg-[var(--monet-surface-2)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--monet-text-strong)]', cls)} {...p} />
    ),
    pre: ({ node: _node, ...p }) => (
      <pre
        className="overflow-x-auto rounded-lg border border-[var(--monet-border)] bg-[var(--monet-surface)] px-2.5 py-2 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs"
        {...p}
      />
    ),
    table: ({ node: _node, ...p }) => (
      <div className="overflow-x-auto font-sans" data-testid="table-ai-message">
        <table className="w-full border-collapse text-xs" {...p} />
      </div>
    ),
    th: ({ node: _node, ...p }) => (
      <th className="border-b border-[var(--monet-border-2)] px-2 py-1.5 text-left font-semibold text-[var(--monet-text)]" {...p} />
    ),
    td: ({ node: _node, ...p }) => <td className="border-b border-[var(--monet-border-2)] px-2 py-1.5 align-top text-[var(--monet-text-soft)]" {...p} />,
    hr: () => <hr className="border-[var(--monet-border)]" />,
    img: ({ node: _node, src, alt }) => {
      // Images from the AI are shown as links rather than loaded inline.
      const href = typeof src === 'string' ? safeHref(src) : null;
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--monet-active-fg)] underline">
          {alt || 'image'}
        </a>
      ) : (
        <span>{alt}</span>
      );
    },
  };
  return (
    <div className={cn('space-y-2 break-words text-sm leading-relaxed [&_li>p]:inline', className)} data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
