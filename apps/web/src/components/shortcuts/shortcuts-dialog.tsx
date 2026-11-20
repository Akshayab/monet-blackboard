import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CANVAS_ESSENTIALS, isTypingTarget, keyLabel, useAppShortcuts, type ShortcutGroup } from './registry';

function Keys({ keys }: { keys: string[] }) {
  // Pointer gestures ("Click an avatar") read better as plain text than as key caps.
  if (keys.length === 1 && keys[0]!.includes(' ')) {
    return <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">{keys[0]}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-b-2 bg-background px-1.5 font-sans text-xs font-medium text-foreground"
        >
          {keyLabel(k)}
        </kbd>
      ))}
    </span>
  );
}

function Group({ group }: { group: ShortcutGroup }) {
  return (
    <section aria-labelledby={`shortcuts-${group.group}`}>
      <h3 id={`shortcuts-${group.group}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {group.group}
      </h3>
      <ul className="mt-2 divide-y rounded-lg border">
        {group.items.map((s) => (
          <li key={s.label + s.keys.join('+')} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
            <span>{s.label}</span>
            <Keys keys={s.keys} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The "?" help overlay on the board page. It lists Monet Blackboard shortcuts (including ones other features
 * register) plus the canvas essentials, and links to Excalidraw's full help dialog.
 * "?" opens this instead of Excalidraw's dialog; the canvas help stays one click away.
 */
export function ShortcutsOverlay({ excalidrawAPI }: { excalidrawAPI: ExcalidrawImperativeAPI | null }) {
  const [open, setOpen] = useState(false);
  const groups = useAppShortcuts();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen((o) => !o);
    }
    // Capture phase on window runs before Excalidraw's document listener.
    window.addEventListener('keydown', onKeyDown, true);
    const onOpen = () => setOpen(true);
    window.addEventListener('monet:open-shortcuts', onOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('monet:open-shortcuts', onOpen);
    };
  }, []);

  function openCanvasHelp() {
    setOpen(false);
    excalidrawAPI?.updateScene({ appState: { openDialog: { name: 'help' } } });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl" data-testid="dialog-shortcuts">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" aria-hidden="true" /> Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>Press ? any time on a board to open this list.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-6">
            {groups.map((g) => (
              <Group key={g.group} group={g} />
            ))}
            <Group group={CANVAS_ESSENTIALS[1]!} />
          </div>
          <div className="space-y-6">
            <Group group={CANVAS_ESSENTIALS[0]!} />
            <Group group={CANVAS_ESSENTIALS[2]!} />
          </div>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {keyLabel('Mod')} stands for {keyLabel('Mod') === '⌘' ? 'Command' : 'Control'}.
          </p>
          <Button variant="outline" size="sm" onClick={openCanvasHelp} disabled={!excalidrawAPI} data-testid="button-canvas-help">
            All canvas shortcuts
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Opens the shortcuts overlay from anywhere (e.g. a menu item). */
export function openShortcutsOverlay() {
  window.dispatchEvent(new Event('monet:open-shortcuts'));
}
