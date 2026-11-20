import { cn } from '@/lib/utils';

/**
 * Monet Blackboard mark: a chalk "M" and an orange sun on a framed blackboard (a nod to Monet's
 * "Impression, Sunrise"). The same drawing is used for the favicon (public/favicon.svg), the
 * apple-touch icon, and the share image (scripts/og/og-image.html).
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7 shrink-0', className)} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#a65a32" />
      <rect x="4.2" y="4.2" width="23.6" height="23.6" rx="4.8" fill="#1f2a26" />
      <circle cx="20.5" cy="11.5" r="4.4" fill="#ef7d45" />
      <path d="M8 22.6 L11 11.4 L14.7 19 L18.4 11.6 L21.4 22.6" fill="none" stroke="#f3efe6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight text-lg text-foreground', className)}>
      <LogoMark className={markClassName} />
      <span>
        Monet <span className="font-normal">Blackboard</span>
      </span>
    </span>
  );
}
