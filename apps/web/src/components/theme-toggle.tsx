// Light / dark switch (the board, the library and every page follow it).
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toggleTheme, useTheme } from '@/lib/theme';

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={(e) => {
        toggleTheme();
        // Give keyboard focus back to the page (on a board, Excalidraw's shortcuts need it).
        e.currentTarget.blur();
      }}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--monet-text)] transition hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8ff7]',
        className,
      )}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      data-testid="button-theme-toggle"
      data-theme={theme}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
