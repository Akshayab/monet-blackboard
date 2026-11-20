import { Loader2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TEMPLATES, TemplatePreview, type TemplateId } from '@/components/templates/templates';

export type CreatingKind = 'blank' | 'prompt' | TemplateId | null;

const tileBase =
  'group relative flex flex-col overflow-hidden rounded-xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60';

/** The "Start new" row: a blank Whiteboard tile plus one tile per template. */
export function StartNew({ creating, onBlank, onTemplate }: { creating: CreatingKind; onBlank: () => void; onTemplate: (id: TemplateId) => void }) {
  const busy = creating !== null;
  return (
    <section className="mt-12" aria-labelledby="start-new-title">
      <h2 id="start-new-title" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Start new
      </h2>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 sm:gap-4">
        <li>
          <button
            type="button"
            onClick={onBlank}
            disabled={busy}
            className={cn(tileBase, 'h-full w-full border-2 border-dashed bg-transparent hover:border-primary hover:bg-primary/5')}
            data-testid="button-new-whiteboard"
          >
            <span className="grid aspect-[4/3] w-full place-items-center">
              {creating === 'blank' ? (
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
              ) : (
                <Plus className="h-7 w-7 text-muted-foreground group-hover:text-primary-text" aria-hidden="true" />
              )}
            </span>
            <span className="px-3 pb-3">
              <span className="block text-sm font-medium">Whiteboard</span>
              <span className="block text-xs text-muted-foreground">Blank board</span>
            </span>
          </button>
        </li>
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onTemplate(t.id)}
              disabled={busy}
              className={cn(tileBase, 'h-full w-full')}
              title={t.description}
              aria-label={`New board from the ${t.name} template: ${t.description}`}
              data-testid={`button-template-${t.id}`}
            >
              <span className="relative block aspect-[4/3] w-full bg-[var(--monet-canvas)] p-1.5">
                <TemplatePreview id={t.id} />
                {creating === t.id && (
                  <span className="absolute inset-0 grid place-items-center bg-black/50">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="border-t px-3 py-2">
                <span className="block truncate text-sm font-medium">{t.name}</span>
                <span className="block truncate text-xs text-muted-foreground">Template</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
