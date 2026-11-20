// Small dark popover menu for the board shell (zoom, shapes, board menu). A plain component instead of the
// Radix dropdown, which fought Excalidraw over focus and wouldn't reopen after a selection.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { refocusCanvas } from '@/board/inputs/overlay';

export function ShellMenu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    // Refocus right away so a shortcut typed just after picking an item (H for the hand tool) reaches the canvas,
    // and again after React re-renders, in case the click moved focus back to the menu.
    refocusCanvas();
    setTimeout(refocusCanvas, 0);
  };
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          className={cn(
            'monet-dark-menu absolute z-50 min-w-[11rem] rounded-xl border p-1 text-[13px]',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
            align === 'end' ? 'right-0' : align === 'start' ? 'left-0' : 'left-1/2 -translate-x-1/2',
            className,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function ShellMenuItem({
  onSelect,
  children,
  shortcut,
  testId,
  danger,
}: {
  onSelect: () => void;
  children: ReactNode;
  shortcut?: string;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-[var(--monet-hover)] focus-visible:bg-[var(--monet-hover)] focus-visible:outline-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-[var(--monet-text-faint)]',
        danger ? 'text-[var(--monet-danger)]' : 'text-[var(--monet-text-strong)]',
      )}
      data-testid={testId}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {shortcut && <span className="text-[11px] text-[var(--monet-text-muted)]">{shortcut}</span>}
    </button>
  );
}

export const ShellMenuSeparator = () => <div role="separator" className="my-1 h-px bg-[var(--monet-border-2)]" />;
