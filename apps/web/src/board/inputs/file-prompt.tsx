// The card that opens where files were dropped: "What should the AI do with this file?", plus (for CSV)
// "Insert as chart", which builds an editable chart locally without the AI.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, FileSpreadsheet, FileText, LineChart, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MAX_SERIES, type ChartSpec, type ChartType, type CsvTable } from './csv-chart';
import { prettySize, type DroppedKind } from './files';
import { clampToWindow, Overlay } from './overlay';

export interface PendingDoc {
  file: File;
  kind: Extract<DroppedKind, 'csv' | 'pdf' | 'text'>;
}

const SUGGESTIONS: Record<PendingDoc['kind'], string[]> = {
  csv: ['Chart this data and call out the key takeaways', 'Summarize the main insights as stickies', 'Group the rows into themes'],
  pdf: ['Turn this document into a structured board', 'Summarize the key points as stickies', 'Pull out action items with owners'],
  text: ['Turn this into a structured board', 'Summarize the key points as stickies', 'Lay this out as a timeline'],
};

const CARD_W = 380;

function DocIcon({ kind }: { kind: PendingDoc['kind'] }) {
  return kind === 'csv' ? <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> : <FileText className="h-4 w-4 text-indigo-600" />;
}

export function FilePrompt(props: {
  docs: PendingDoc[];
  /** Client coordinates of the drop point. */
  anchor: { x: number; y: number };
  table: CsvTable | null;
  tableError: string | null;
  notes: string[];
  onSend: (prompt: string) => Promise<void>;
  onInsertChart: (spec: ChartSpec) => void;
  onCancel: () => void;
}) {
  const { docs, anchor, table, tableError, notes, onSend, onInsertChart, onCancel } = props;
  const [mode, setMode] = useState<'ask' | 'chart'>('ask');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const firstCsv = docs.find((d) => d.kind === 'csv');
  const primaryKind = docs[0]!.kind;

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const send = async (text = prompt) => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const pos = clampToWindow(anchor.x + 12, anchor.y + 12, CARD_W, mode === 'chart' ? 470 : 360);

  return (
    <Overlay>
      <div
        className="fixed z-40 rounded-xl border bg-white shadow-xl text-sm text-foreground"
        style={{ left: pos.left, top: pos.top, width: CARD_W }}
        data-testid="card-file-prompt"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <div className="flex items-start gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            {docs.map((d) => (
              <div key={d.file.name + d.file.size} className="flex items-center gap-2 min-w-0">
                <DocIcon kind={d.kind} />
                <span className="truncate font-medium" data-testid="text-dropped-file">
                  {d.file.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{prettySize(d.file.size)}</span>
              </div>
            ))}
          </div>
          <button className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={onCancel} aria-label="Close" data-testid="button-file-prompt-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {mode === 'ask' ? (
          <div className="space-y-3 px-4 py-3">
            <label className="block font-medium" htmlFor="monet-file-prompt">
              What should the AI do with {docs.length > 1 ? 'these files' : 'this file'}?
            </label>
            <Textarea
              id="monet-file-prompt"
              ref={textRef}
              value={prompt}
              rows={3}
              disabled={busy}
              placeholder="e.g. Turn this into a board with the main themes"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              className="resize-none"
              data-testid="input-file-prompt"
            />
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS[primaryKind].map((s) => (
                <button
                  key={s}
                  disabled={busy}
                  onClick={() => void send(s)}
                  className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  data-testid="button-file-suggestion"
                >
                  {s}
                </button>
              ))}
            </div>
            {notes.map((n) => (
              <p key={n} className="text-xs text-muted-foreground">
                {n}
              </p>
            ))}
            {error && (
              <p className="text-xs text-destructive-text" data-testid="text-file-prompt-error">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              {firstCsv ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !table}
                  title={tableError ?? 'Build an editable chart from the columns, without the AI'}
                  onClick={() => setMode('chart')}
                  data-testid="button-insert-as-chart"
                >
                  <BarChart3 /> Insert as chart
                </Button>
              ) : (
                <span />
              )}
              <Button size="sm" disabled={busy || !prompt.trim()} onClick={() => void send()} data-testid="button-send-file-to-ai">
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Send to AI
              </Button>
            </div>
            {firstCsv && tableError && <p className="text-xs text-muted-foreground">{tableError}</p>}
          </div>
        ) : (
          table && (
            <ChartOptions
              table={table}
              defaultTitle={firstCsv!.file.name.replace(/\.[^.]+$/, '')}
              source={firstCsv!.file.name}
              onBack={() => setMode('ask')}
              onInsert={onInsertChart}
            />
          )
        )}
      </div>
    </Overlay>
  );
}

function ChartOptions(props: { table: CsvTable; defaultTitle: string; source: string; onBack: () => void; onInsert: (spec: ChartSpec) => void }) {
  const { table, defaultTitle, source, onBack, onInsert } = props;
  const [type, setType] = useState<ChartType>('bar');
  const [title, setTitle] = useState(defaultTitle);
  const [labelColumn, setLabelColumn] = useState(table.labelColumn);
  const valueOptions = useMemo(() => table.numericColumns.filter((c) => c !== labelColumn), [table, labelColumn]);
  const [valueColumns, setValueColumns] = useState<string[]>(() => valueOptions.slice(0, 1));
  const chosen = valueColumns.filter((c) => valueOptions.includes(c));

  const toggle = (c: string, on: boolean) =>
    setValueColumns((prev) => (on ? [...prev.filter((p) => p !== c), c].slice(-MAX_SERIES) : prev.filter((p) => p !== c)));

  return (
    <div className="space-y-3 px-4 py-3" data-testid="panel-chart-options">
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {(['bar', 'line'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium',
              type === t ? 'bg-white shadow-sm' : 'text-muted-foreground',
            )}
            data-testid={`button-chart-type-${t}`}
          >
            {t === 'bar' ? <BarChart3 className="h-3.5 w-3.5" /> : <LineChart className="h-3.5 w-3.5" />}
            {t === 'bar' ? 'Bar chart' : 'Line chart'}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="monet-chart-title">
          Title
        </label>
        <Input id="monet-chart-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-8" data-testid="input-chart-title" />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="monet-chart-labels">
          Labels
        </label>
        <select
          id="monet-chart-labels"
          value={labelColumn}
          onChange={(e) => setLabelColumn(e.target.value)}
          className="h-8 w-full rounded-md border bg-white px-2 text-sm"
          data-testid="select-chart-labels"
        >
          {table.columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Values (up to {MAX_SERIES})</div>
        {valueOptions.length ? (
          <div className="max-h-28 space-y-1 overflow-auto">
            {valueOptions.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <Checkbox checked={chosen.includes(c)} onCheckedChange={(v) => toggle(c, v === true)} data-testid={`checkbox-chart-value-${c}`} />
                <span className="truncate">{c}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No numeric columns found besides the label column.</p>
        )}
      </div>
      <div className="flex items-center justify-between pt-1">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-chart-back">
          Back
        </Button>
        <Button
          size="sm"
          disabled={!chosen.length}
          onClick={() => onInsert({ type, title: title.trim() || defaultTitle, labelColumn, valueColumns: chosen, source })}
          data-testid="button-insert-chart"
        >
          Insert chart
        </Button>
      </div>
    </div>
  );
}
