// Getting things onto the board: drag and drop or paste files onto the canvas, embed videos and links,
// clean up sketches with the AI, and chart CSV data locally. Mounted through BoardSlots.Children.
//
// - Images: Excalidraw inserts single small images itself; large images (and multi-file drops) are
//   downscaled here and inserted as image elements. Files sync through the collab hook's file upload.
// - CSV / PDF / text files open "What should the AI do with this file?" at the drop point; CSV can also
//   be inserted as an editable chart without the AI.
// - Video files can't be uploaded (no media storage yet); the embed dialog opens instead.
// - Sticky notes: a sticky tool next to Excalidraw's toolbar (shortcut N), see sticky-tool.tsx.
// - Live embeds (poll, timer, calculator, prototype) run sealed with shared state, see live-embeds/.
// - Face-sticker votes (Vote button / U) with count badges, see votes.tsx; a Lock button in the properties panel.
// - Realtime errors that don't close the board (board full, too many changes) show as a toast.
// - Viewers can't drop or paste anything, and none of the actions show for them.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevice } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Loader2, Paperclip, UploadCloud, Video } from 'lucide-react';
import { makeEmbed, makeImage, type SceneElement } from '@monet/board-protocol';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { useTheme } from '@/lib/theme';
import type { BoardContext } from '../slots';
import { requestAi, type AiAttachment } from './ai';
import { buildChart, parseCsv, type ChartSpec, type CsvTable } from './csv-chart';
import { EmbedDialog, type LiveEmbedSpec } from './embed-dialog';
import { LockButton } from './arrange';
import { setLiveEmbedHost } from './live-embeds/frame';
import { defaultEmbedSize, LIVE_EMBED_HOST } from './live-embeds/templates';
import { Votes, type Voter } from './votes';
import type { ParsedEmbed } from './embeds';
import { FilePrompt, type PendingDoc } from './file-prompt';
import {
  classifyFile,
  downscaleImage,
  fileIdFor,
  MAX_PDF_BYTES,
  needsDownscale,
  prettySize,
  readAsDataURL,
  readText,
  textMimeType,
  type PreparedImage,
} from './files';
import { isInOverlay, isWritable, Overlay, refocusCanvas } from './overlay';
import { clientToScene, findFreeSpot, insertElements, sceneToClient, viewportCenter, visibleSceneRect } from './scene';
import { SketchCleanup } from './sketch-cleanup';
import { StickyTool } from './sticky-tool';
import { useSceneState, type SceneState } from './use-scene-state';

export { embedProps } from './embeds';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MARKER_TTL_MS = 3 * 60 * 1000;

interface PromptState {
  docs: PendingDoc[];
  at: { x: number; y: number };
  table: CsvTable | null;
  tableError: string | null;
  notes: string[];
}

interface Marker {
  runId: string;
  x: number;
  y: number;
  label: string;
  started: number;
}

/** Files Excalidraw already handles well on its own: one normal-sized image, or an .excalidraw scene. */
function nativeHandles(files: File[]) {
  if (files.length !== 1) return false;
  const f = files[0]!;
  const kind = classifyFile(f);
  if (kind === 'image') return !needsDownscale(f) && !!f.type;
  return kind === 'other' && /\.excalidraw(lib)?$/i.test(f.name);
}

function inCanvas(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('.excalidraw-container') && !isInOverlay(target);
}

function block(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function loadImageSize(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 400, height: 300 });
    img.src = dataURL;
  });
}

async function prepareImage(file: File): Promise<PreparedImage & { id: string }> {
  let prepared: PreparedImage;
  if (needsDownscale(file)) {
    prepared = await downscaleImage(file);
  } else {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is too large (${prettySize(file.size)}). Images can be up to 4 MB.`);
    const dataURL = await readAsDataURL(file);
    const mimeType = file.type || dataURL.slice(5, dataURL.indexOf(';')) || 'image/png';
    prepared = { dataURL, mimeType, ...(await loadImageSize(dataURL)) };
  }
  return { ...prepared, id: await fileIdFor(prepared.dataURL) };
}

export function BoardInputs({ ctx }: { ctx: BoardContext }) {
  const { excalidrawAPI: api, canEdit, role, boardId, linkToken, collab } = ctx;
  const scene = useSceneState(api);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [embed, setEmbed] = useState<{ open: boolean; note: string | null; at: { x: number; y: number } | null; tab?: 'link' | 'live' }>({
    open: false,
    note: null,
    at: null,
  });
  const me: Voter | null = collab.me
    ? { id: collab.me.userId, name: collab.me.name, color: collab.me.color }
    : ctx.user
      ? { id: ctx.user.id, name: ctx.user.displayName || 'Someone', color: '#5b9cf0' }
      : null;
  const theme = useTheme();

  // Live embeds read who you are, whether you can edit, and the theme from here.
  useEffect(() => {
    setLiveEmbedHost({ api, me, canEdit, theme });
  }, [api, me?.id, me?.name, me?.color, canEdit, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime errors that don't end the session (board full, too many changes at once, ...) as a toast.
  useEffect(() => {
    const e = collab.error;
    if (!e || ['forbidden', 'deleted', 'unauthenticated'].includes(e.code)) return;
    const full = /full|too_large|too_many|limit/i.test(e.code);
    toast({
      title: full ? 'This board is full' : e.code === 'rate_limited' ? 'Slow down a little' : "Couldn't save that change",
      description: full ? `${e.message} Your latest changes weren't saved for others.` : e.message,
      variant: full ? 'destructive' : undefined,
    });
  }, [collab.error]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [dragging, setDragging] = useState(false);
  const finishedRuns = useRef(new Set<string>());
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const insertImages = useCallback(async (api: ExcalidrawImperativeAPI, files: File[], at: { x: number; y: number }, findSpace: boolean) => {
    const prepared: (PreparedImage & { id: string })[] = [];
    for (const f of files) {
      try {
        prepared.push(await prepareImage(f));
      } catch (err) {
        toast({ title: "Couldn't add image", description: err instanceof Error ? err.message : f.name, variant: 'destructive' });
      }
    }
    if (!prepared.length) return;
    const app = api.getAppState();
    const zoom = app.zoom.value;
    const maxW = (app.width * (prepared.length > 1 ? 0.3 : 0.45)) / zoom;
    const maxH = (app.height * 0.5) / zoom;
    const sizes = prepared.map((p) => {
      const s = Math.min(1, maxW / p.width, maxH / p.height);
      return { w: Math.round(p.width * s), h: Math.round(p.height * s) };
    });
    const gap = 24;
    const total = sizes.reduce((sum, s) => sum + s.w, 0) + gap * (sizes.length - 1);
    const tallest = Math.max(...sizes.map((s) => s.h));
    // Dropped at a point: center there. Picked or pasted without a pointer: find an empty spot in view.
    const origin = findSpace ? findFreeSpot(api, at, total, tallest) : { x: at.x - total / 2, y: at.y - tallest / 2, inView: true };
    let x = origin.x;
    const midY = origin.y + tallest / 2;
    api.addFiles(prepared.map((p) => ({ id: p.id as never, dataURL: p.dataURL as never, mimeType: p.mimeType as never, created: Date.now() })));
    const elements: SceneElement[] = prepared.map((p, i) => {
      const { w, h } = sizes[i]!;
      const el = makeImage({ fileId: p.id, x, y: midY - h / 2, width: w, height: h });
      x += w + gap;
      return el;
    });
    insertElements(api, elements, { select: true, scrollIntoView: !origin.inView });
    refocusCanvas();
  }, []);

  const openPrompt = useCallback(async (docs: PendingDoc[], at: { x: number; y: number }) => {
    const notes: string[] = [];
    if (docs.length > MAX_ATTACHMENTS) {
      notes.push(`Only the first ${MAX_ATTACHMENTS} files will be sent.`);
      docs = docs.slice(0, MAX_ATTACHMENTS);
    }
    let table: CsvTable | null = null;
    let tableError: string | null = null;
    const csv = docs.find((d) => d.kind === 'csv');
    if (csv) {
      try {
        table = parseCsv((await readText(csv.file)).text);
        if (!table.numericColumns.length) tableError = 'No numeric columns to chart in this CSV.';
      } catch (err) {
        tableError = err instanceof Error ? err.message : 'Could not read this CSV.';
      }
    }
    setPrompt({ docs, at, table, tableError, notes });
  }, []);

  /** Handles dropped, pasted or picked files. `client` is the window position they arrived at. */
  const processFiles = useCallback(
    async (files: File[], client: { x: number; y: number } | null) => {
      if (!api) return;
      const app = api.getAppState();
      const at = client ? clientToScene(client.x, client.y, app) : viewportCenter(app);
      const images: File[] = [];
      const docs: PendingDoc[] = [];
      let video = false;
      const skipped: string[] = [];
      let spreadsheet = false;
      for (const f of files) {
        const kind = classifyFile(f);
        if (kind === 'image') images.push(f);
        else if (kind === 'csv' || kind === 'pdf' || kind === 'text') docs.push({ file: f, kind });
        else if (kind === 'video') video = true;
        else if (kind === 'spreadsheet') spreadsheet = true;
        else skipped.push(f.name);
      }
      if (spreadsheet) toast({ title: 'Save the spreadsheet as CSV', description: 'Export it as a .csv file, then drop that on the board.' });
      if (skipped.length) toast({ title: "Can't add that file type yet", description: `${skipped.join(', ')}. Try images, CSV, PDF or text files.` });
      if (video) {
        setEmbed({
          open: true,
          at,
          note: "Video files can't be uploaded yet. Paste a YouTube, Vimeo or Loom link to the video instead.",
        });
      }
      if (images.length) await insertImages(api, images, at, !client);
      if (docs.length) await openPrompt(docs, images.length ? { x: at.x, y: at.y + 40 } : at);
    },
    [api, insertImages, openPrompt],
  );

  // Native capture-phase listeners run before Excalidraw's own drop and paste handling.
  const live = useRef({ canEdit, role, processFiles });
  live.current = { canEdit, role, processFiles };
  useEffect(() => {
    if (!api) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const denyViewer = () => {
      if (live.current.role === 'viewer') toast({ title: 'This board is view only', description: 'Ask the owner for edit access to add things.' });
    };
    const onDragOver = (e: DragEvent) => {
      if (!inCanvas(e.target) || !e.dataTransfer?.types.includes('Files') || !live.current.canEdit) return;
      setDragging(true);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setDragging(false), 250);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      if (!inCanvas(e.target)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!live.current.canEdit) {
        block(e);
        denyViewer();
        return;
      }
      // Dropped links/text go to Excalidraw, which turns URLs into embeds (see embeds.tsx).
      if (!files.length || nativeHandles(files)) return;
      block(e);
      void live.current.processFiles(files, { x: e.clientX, y: e.clientY });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isWritable(e.target) || isInOverlay(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      const p = lastPointer.current;
      const overCanvas = p ? inCanvas(document.elementFromPoint(p.x, p.y)) : false;
      if (!overCanvas && !inCanvas(document.activeElement)) return;
      if (!live.current.canEdit) {
        block(e);
        denyViewer();
        return;
      }
      if (nativeHandles(files)) return;
      block(e);
      void live.current.processFiles(files, overCanvas ? p : null);
    };
    const onPointerMove = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [api]);

  // Close the prompt if edit access goes away (e.g. the owner switches the link to view only).
  useEffect(() => {
    if (!canEdit) {
      setPrompt(null);
      setEmbed((s) => (s.open ? { ...s, open: false } : s));
    }
  }, [canEdit]);

  // "AI is working" markers at the drop point, cleared when the run finishes.
  const finishRun = useCallback((runId: string) => {
    finishedRuns.current.add(runId);
    setMarkers((ms) => ms.filter((m) => m.runId !== runId));
  }, []);
  useEffect(() => {
    const r = collab.aiRun;
    if (r && (r.status === 'done' || r.status === 'error')) finishRun(r.runId);
  }, [collab.aiRun, finishRun]);
  useEffect(
    () =>
      collab.onChat((msg) => {
        const runId = msg.meta?.runId;
        if (msg.role === 'assistant' && typeof runId === 'string') finishRun(runId);
      }),
    [collab.onChat, finishRun],
  );
  useEffect(() => {
    if (!markers.length) return;
    const t = setInterval(() => setMarkers((ms) => ms.filter((m) => Date.now() - m.started < MARKER_TTL_MS)), 10_000);
    return () => clearInterval(t);
  }, [markers.length]);
  const addMarker = useCallback((m: Omit<Marker, 'started'>) => {
    if (finishedRuns.current.has(m.runId)) return;
    setMarkers((ms) => [...ms.filter((x) => x.runId !== m.runId), { ...m, started: Date.now() }]);
  }, []);

  const sendDocs = useCallback(
    async (text: string) => {
      if (!api || !prompt) return;
      const attachments: AiAttachment[] = [];
      for (const d of prompt.docs) {
        if (d.kind === 'pdf') {
          if (d.file.size > MAX_PDF_BYTES) throw new Error(`${d.file.name} is too large (${prettySize(d.file.size)}). PDFs can be up to 8 MB.`);
          attachments.push({ name: d.file.name, mimeType: 'application/pdf', dataURL: await readAsDataURL(d.file) });
        } else {
          const { text: content, truncated } = await readText(d.file);
          if (truncated) toast({ title: `${d.file.name} is long`, description: 'Only the first 400,000 characters were sent to the AI.' });
          attachments.push({ name: d.file.name, mimeType: textMimeType(d.file, d.kind), text: content });
        }
      }
      const vis = visibleSceneRect(api.getAppState());
      const { at } = prompt;
      const viewport = {
        x: at.x,
        y: at.y,
        width: Math.max(600, vis.x + vis.width - at.x),
        height: Math.max(400, vis.y + vis.height - at.y),
      };
      const { runId } = await requestAi(boardId, linkToken, { prompt: text, attachments, viewport });
      const names = prompt.docs.map((d) => d.file.name);
      addMarker({ runId, x: at.x, y: at.y, label: `Reading ${names.length > 1 ? `${names.length} files` : names[0]}…` });
      setPrompt(null);
      refocusCanvas();
    },
    [addMarker, api, boardId, linkToken, prompt],
  );

  const insertChart = useCallback(
    (spec: ChartSpec) => {
      if (!api || !prompt?.table) return;
      try {
        const chart = buildChart(prompt.table, spec, prompt.at);
        insertElements(api, chart.elements, { select: true, groupId: chart.groupId, anchors: chart.anchors });
        if (chart.truncated) toast({ title: 'Charted the first 40 rows', description: 'Large tables are trimmed so the chart stays readable.' });
        setPrompt(null);
        refocusCanvas();
      } catch (err) {
        toast({ title: "Couldn't build the chart", description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
      }
    },
    [api, prompt],
  );

  const insertEmbed = useCallback(
    (parsed: ParsedEmbed) => {
      if (!api) return;
      const pos = embed.at
        ? { x: embed.at.x - parsed.width / 2, y: embed.at.y - parsed.height / 2, inView: true }
        : findFreeSpot(api, viewportCenter(api.getAppState()), parsed.width, parsed.height);
      const el = makeEmbed({
        url: parsed.url,
        x: pos.x,
        y: pos.y,
        width: parsed.width,
        height: parsed.height,
        roughness: 0,
        strokeColor: parsed.kind === 'link' ? '#dee2e6' : '#1e1e1e',
        customData: { kind: 'embed', embedKind: parsed.kind },
      });
      insertElements(api, [el], { select: true, scrollIntoView: !pos.inView });
    },
    [api, embed.at],
  );

  const insertLive = useCallback(
    (spec: LiveEmbedSpec) => {
      if (!api) return;
      const { width, height } = defaultEmbedSize(spec.embedKind, spec.config);
      const pos = findFreeSpot(api, viewportCenter(api.getAppState()), width, height);
      const el = makeEmbed({
        url: `https://${LIVE_EMBED_HOST}/${spec.embedKind}`,
        x: pos.x,
        y: pos.y,
        width,
        height,
        roughness: 0,
        strokeColor: '#333333',
        customData: {
          kind: 'live-embed',
          embedKind: spec.embedKind,
          title: spec.title,
          config: spec.config,
          ...(spec.html ? { html: spec.html } : {}),
          state: {},
        },
      });
      insertElements(api, [el], { select: true, scrollIntoView: !pos.inView });
    },
    [api],
  );

  if (!api) return null;

  return (
    <>
      {canEdit && scene && (
        <>
          <InsertBar scene={scene} onEmbed={() => setEmbed({ open: true, note: null, at: null })} onPickFile={() => fileInput.current?.click()} />
          <StickyTool api={api} scene={scene} />
          <LockButton api={api} scene={scene} />
          <SketchCleanup
            api={api}
            scene={scene}
            boardId={boardId}
            linkToken={linkToken}
            onStarted={addMarker}
            onError={(message) => toast({ title: "Couldn't clean up the sketch", description: message, variant: 'destructive' })}
          />
          {dragging && <DropHint scene={scene} />}
        </>
      )}
      {canEdit && prompt && scene && (
        <FilePrompt
          key={prompt.docs.map((d) => d.file.name).join('|')}
          docs={prompt.docs}
          anchor={sceneToClient(prompt.at.x, prompt.at.y, scene.app)}
          table={prompt.table}
          tableError={prompt.tableError}
          notes={prompt.notes}
          onSend={sendDocs}
          onInsertChart={insertChart}
          onCancel={() => {
            setPrompt(null);
            refocusCanvas();
          }}
        />
      )}
      {scene && markers.length > 0 && <AiMarkers scene={scene} markers={markers} />}
      {scene && <Votes api={api} scene={scene} collab={collab} me={me} canEdit={canEdit} />}
      <Overlay>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,.csv,.tsv,.pdf,.txt,.md,.json,text/csv,application/pdf,text/plain"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void processFiles(files, null);
          }}
          data-testid="input-add-file"
        />
        <EmbedDialog
          open={embed.open && canEdit}
          note={embed.note}
          initialTab={embed.tab}
          onOpenChange={(open) => setEmbed((s) => ({ ...s, open }))}
          onInsert={insertEmbed}
          onInsertLive={insertLive}
        />
      </Overlay>
    </>
  );
}

function InsertBar({ scene, onEmbed, onPickFile }: { scene: SceneState; onEmbed: () => void; onPickFile: () => void }) {
  const device = useDevice();
  const { app } = scene;
  if (device.editor.isMobile) {
    // Bottom-center above Excalidraw's mobile toolbar.
    return (
      <Overlay>
        <div
          className="fixed z-20 flex -translate-x-1/2 gap-1 rounded-full border bg-white/95 p-1 shadow-md"
          style={{ left: app.offsetLeft + app.width / 2, top: app.offsetTop + app.height - 116 }}
          data-testid="toolbar-inputs-mobile"
        >
          <BarButton label="Embed video or link" onClick={onEmbed} testId="button-embed-open">
            <Video className="h-4 w-4" />
          </BarButton>
          <BarButton label="Add a file" onClick={onPickFile} testId="button-add-file">
            <Paperclip className="h-4 w-4" />
          </BarButton>
        </div>
      </Overlay>
    );
  }
  return (
    <Overlay>
      <div
        className="fixed z-20 flex -translate-y-1/2 flex-col gap-1 rounded-xl border bg-white/95 p-1 shadow-md"
        style={{ left: app.offsetLeft + app.width - 60, top: app.offsetTop + app.height / 2 }}
        data-testid="toolbar-inputs"
      >
        <BarButton label="Embed video or link" onClick={onEmbed} testId="button-embed-open">
          <Video className="h-4 w-4" />
        </BarButton>
        <BarButton label="Add image, CSV, PDF or text file" onClick={onPickFile} testId="button-add-file">
          <Paperclip className="h-4 w-4" />
        </BarButton>
      </div>
    </Overlay>
  );
}

function BarButton({ label, onClick, testId, children }: { label: string; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="grid h-9 w-9 place-items-center rounded-lg text-neutral-700 hover:bg-neutral-100"
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function DropHint({ scene }: { scene: SceneState }) {
  const { app } = scene;
  return (
    <Overlay>
      <div
        className="pointer-events-none fixed z-30 grid place-items-center rounded-lg border-2 border-dashed border-indigo-400 bg-indigo-50/40"
        style={{ left: app.offsetLeft + 8, top: app.offsetTop + 8, width: app.width - 16, height: app.height - 16 }}
        data-testid="overlay-drop-hint"
      >
        <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-indigo-700 shadow">
          <UploadCloud className="h-4 w-4" /> Drop images, CSV, PDF or text files
        </div>
      </div>
    </Overlay>
  );
}

function AiMarkers({ scene, markers }: { scene: SceneState; markers: Marker[] }) {
  const { app } = scene;
  return (
    <Overlay>
      {markers.map((m) => {
        const p = sceneToClient(m.x, m.y, app);
        if (p.x < app.offsetLeft || p.y < app.offsetTop || p.x > app.offsetLeft + app.width || p.y > app.offsetTop + app.height) return null;
        return (
          <div
            key={m.runId}
            className="pointer-events-none fixed z-20 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 shadow-md"
            style={{ left: p.x, top: p.y }}
            data-testid="marker-ai-working"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {m.label}
          </div>
        );
      })}
    </Overlay>
  );
}
