// "Embed": paste a YouTube, Vimeo or Loom link (plays inline) or any web address (link card), or add a live
// embed (poll, timer, calculator, prototype) that runs sealed on the board and shares what people enter.
import { useEffect, useState } from 'react';
import { BarChart3, Calculator, Code2, Link2, Timer, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { parseEmbedUrl, type ParsedEmbed } from './embeds';
import { KIND_LABELS, MAX_EMBED_HTML, type LiveEmbedKind } from './live-embeds/templates';
import { refocusCanvas } from './overlay';

export interface LiveEmbedSpec {
  embedKind: LiveEmbedKind;
  title: string;
  config: Record<string, unknown>;
  html?: string;
}

type Tab = 'link' | 'live';
const LIVE_KINDS: { kind: LiveEmbedKind; icon: React.ReactNode; hint: string }[] = [
  { kind: 'poll', icon: <BarChart3 className="h-4 w-4" />, hint: 'One vote each, live results' },
  { kind: 'timer', icon: <Timer className="h-4 w-4" />, hint: 'Shared countdown' },
  { kind: 'calculator', icon: <Calculator className="h-4 w-4" />, hint: 'Shared display and history' },
  { kind: 'prototype', icon: <Code2 className="h-4 w-4" />, hint: 'Run your own HTML' },
];

export function EmbedDialog(props: {
  open: boolean;
  note?: string | null;
  initialTab?: Tab;
  onOpenChange: (open: boolean) => void;
  onInsert: (embed: ParsedEmbed) => void;
  onInsertLive: (spec: LiveEmbedSpec) => void;
}) {
  const { open, note, initialTab, onOpenChange, onInsert, onInsertLive } = props;
  const [tab, setTab] = useState<Tab>('link');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<LiveEmbedKind>('poll');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('Yes\nNo');
  const [minutes, setMinutes] = useState('5');
  const [label, setLabel] = useState('');
  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (!open) return;
    setTab(initialTab ?? 'link');
    setValue('');
  }, [open, initialTab]);
  const parsed = parseEmbedUrl(value);
  const isVideo = parsed && parsed.kind !== 'link';

  const optionList = options
    .split('\n')
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, 8);
  const mins = Math.round(Number(minutes));
  const liveError =
    kind === 'poll' && optionList.length < 2
      ? 'Add at least two options, one per line.'
      : kind === 'timer' && !(mins >= 1 && mins <= 99)
        ? 'Pick 1 to 99 minutes.'
        : kind === 'prototype' && !html.trim()
          ? 'Paste the HTML to run.'
          : kind === 'prototype' && html.length > MAX_EMBED_HTML
            ? `HTML is limited to ${MAX_EMBED_HTML.toLocaleString('en-US')} characters.`
            : null;

  const submit = () => {
    if (tab === 'link') {
      if (!parsed) return;
      onInsert(parsed);
    } else {
      if (liveError) return;
      const spec: LiveEmbedSpec =
        kind === 'poll'
          ? { embedKind: 'poll', title: question.trim() || 'Poll', config: { question: question.trim() || 'Poll', options: optionList } }
          : kind === 'timer'
            ? { embedKind: 'timer', title: label.trim() || 'Timer', config: { seconds: mins * 60, label: label.trim() || 'Timer' } }
            : kind === 'calculator'
              ? { embedKind: 'calculator', title: title.trim() || 'Calculator', config: {} }
              : { embedKind: 'prototype', title: title.trim() || 'Prototype', config: {}, html };
      onInsertLive(spec);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="dialog-embed"
        onCloseAutoFocus={(e) => {
          // Return focus to the canvas (not the toolbar button) so shortcuts keep working.
          e.preventDefault();
          refocusCanvas();
        }}
      >
        <DialogHeader>
          <DialogTitle>Embed</DialogTitle>
          <DialogDescription>
            {tab === 'link'
              ? 'YouTube, Vimeo and Loom videos play right on the board. Other links show up as a card anyone can open.'
              : 'Small working apps on the board. What people enter is saved and shared, and they run sealed off with no network access.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {(['link', 'live'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('flex-1 rounded-md py-1.5 text-xs font-medium', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground')}
              data-testid={`tab-embed-${t}`}
            >
              {t === 'link' ? 'Video or link' : 'Live embed'}
            </button>
          ))}
        </div>
        {note && tab === 'link' && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="text-embed-note">
            {note}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          {tab === 'link' ? (
            <div className="space-y-2">
              <Input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                data-testid="input-embed-url"
              />
              <p className="flex h-5 items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-embed-kind">
                {value.trim() &&
                  (parsed ? (
                    <>
                      {isVideo ? <Video className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                      {parsed.label}
                    </>
                  ) : (
                    'Enter a full web address'
                  ))}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {LIVE_KINDS.map((k) => (
                  <button
                    type="button"
                    key={k.kind}
                    onClick={() => setKind(k.kind)}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border p-2 text-left',
                      kind === k.kind ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                    )}
                    aria-pressed={kind === k.kind}
                    data-testid={`button-live-kind-${k.kind}`}
                  >
                    <span className="mt-0.5">{k.icon}</span>
                    <span>
                      <span className="block text-sm font-medium">{KIND_LABELS[k.kind]}</span>
                      <span className="block text-xs text-muted-foreground">{k.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              {kind === 'poll' && (
                <div className="space-y-2">
                  <Input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Question, e.g. Which launch date?"
                    data-testid="input-poll-question"
                  />
                  <Textarea
                    value={options}
                    onChange={(e) => setOptions(e.target.value)}
                    rows={4}
                    placeholder="One option per line"
                    data-testid="input-poll-options"
                  />
                </div>
              )}
              {kind === 'timer' && (
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    className="w-24"
                    aria-label="Minutes"
                    data-testid="input-timer-minutes"
                  />
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Brainstorm" data-testid="input-timer-label" />
                </div>
              )}
              {kind === 'calculator' && (
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" data-testid="input-live-title" />
              )}
              {kind === 'prototype' && (
                <div className="space-y-2">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" data-testid="input-live-title" />
                  <Textarea
                    value={html}
                    onChange={(e) => setHtml(e.target.value)}
                    rows={7}
                    className="font-mono text-xs"
                    placeholder={'<button onclick="monet.setState({clicks: (monet.getState().clicks||0)+1})">Click</button>'}
                    data-testid="input-prototype-html"
                  />
                  <p className="text-xs text-muted-foreground">
                    {html.length.toLocaleString('en-US')} / {MAX_EMBED_HTML.toLocaleString('en-US')} characters · use window.monet.getState / setState / onState
                    to share data
                  </p>
                </div>
              )}
              {liveError && <p className="text-xs text-muted-foreground">{liveError}</p>}
            </>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={tab === 'link' ? !parsed : !!liveError}
            onClick={submit}
            data-testid={tab === 'link' ? 'button-embed-insert' : 'button-embed-insert-live'}
          >
            Add to board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
