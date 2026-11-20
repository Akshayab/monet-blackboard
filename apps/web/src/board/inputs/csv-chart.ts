// "Insert as chart": turns CSV columns into an editable bar or line chart made of ordinary board elements
// (a card, axes, gridlines, bars or lines, and labels, all grouped), without calling the AI.
import Papa from 'papaparse';
import { FONT, makeLine, makeShape, makeText, newId, type SceneElement } from '@monet/board-protocol';
import type { TextAnchors } from './scene';

export interface CsvTable {
  columns: string[];
  rows: string[][];
  numericColumns: string[];
  /** Best guess for the category column (first non-numeric column). */
  labelColumn: string;
}

export type ChartType = 'bar' | 'line';

export interface ChartSpec {
  type: ChartType;
  title: string;
  labelColumn: string;
  valueColumns: string[];
  source?: string;
}

export const MAX_CATEGORIES = 40;
export const MAX_SERIES = 4;
export const SERIES_COLORS = ['#4c6ef5', '#12b886', '#f59f00', '#e64980'];

/** Parses "1,234.5", "$12", "45%", "(300)" and similar into numbers. */
export function parseNumber(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s,$€£¥₹%]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseCsv(text: string): CsvTable {
  const res = Papa.parse<string[]>(text.replace(/^\uFEFF/, '').trim(), { skipEmptyLines: 'greedy' });
  const data = (res.data ?? []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim()));
  if (data.length < 2) throw new Error('This CSV needs a header row and at least one row of data.');
  const header = data[0]!;
  const width = Math.max(...data.map((r) => r.length));
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, i) => {
    let name = String(header[i] ?? '').trim() || `Column ${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    return name;
  });
  const rows = data.slice(1).map((r) => columns.map((_, i) => String(r[i] ?? '').trim()));
  const numericColumns = columns.filter((_, i) => {
    const values = rows.map((r) => r[i]!).filter(Boolean);
    if (!values.length) return false;
    const numeric = values.filter((v) => parseNumber(v) !== null).length;
    return numeric / values.length >= 0.8;
  });
  const labelColumn = columns.find((c) => !numericColumns.includes(c)) ?? columns[0]!;
  return { columns, rows, numericColumns, labelColumn };
}

function niceStep(range: number, targetTicks = 4): number {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function formatValue(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number, unit: string) => `${Number(v.toFixed(v >= 100 ? 0 : 1))}${unit}`;
  if (abs >= 1e9) return `${n < 0 ? '-' : ''}${trim(abs / 1e9, 'B')}`;
  if (abs >= 1e6) return `${n < 0 ? '-' : ''}${trim(abs / 1e6, 'M')}`;
  if (abs >= 1e4) return `${n < 0 ? '-' : ''}${trim(abs / 1e3, 'k')}`;
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return Number(n.toPrecision(3)).toString();
}

function shorten(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface BuiltChart {
  elements: SceneElement[];
  groupId: string;
  anchors: TextAnchors;
  truncated: boolean;
  width: number;
  height: number;
}

/** Builds chart elements with the card's top-left corner at `origin` (scene coordinates). */
export function buildChart(table: CsvTable, spec: ChartSpec, origin: { x: number; y: number }): BuiltChart {
  const labelIdx = table.columns.indexOf(spec.labelColumn);
  const series = spec.valueColumns
    .slice(0, MAX_SERIES)
    .map((c) => ({ name: c, idx: table.columns.indexOf(c) }))
    .filter((s) => s.idx >= 0);
  if (!series.length) throw new Error('Pick at least one numeric column to chart.');
  const allRows = table.rows.filter((r) => series.some((s) => parseNumber(r[s.idx]) !== null));
  if (!allRows.length) throw new Error('Those columns have no numbers to chart.');
  const truncated = allRows.length > MAX_CATEGORIES;
  const rows = allRows.slice(0, MAX_CATEGORIES);
  const labels = rows.map((r, i) => (labelIdx >= 0 ? r[labelIdx] : '') || `${i + 1}`);
  const values = series.map((s) => rows.map((r) => parseNumber(r[s.idx])));

  const flat = values.flat().filter((v): v is number => v !== null);
  let lo = Math.min(0, ...flat);
  let hi = Math.max(0, ...flat);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const groupId = newId();
  const customData = { kind: 'chart', chartId: groupId, source: 'csv' };
  const common = { groupIds: [groupId], roughness: 0, customData };
  const anchors: TextAnchors = new Map();
  const out: SceneElement[] = [];

  const n = rows.length;
  const pad = 28;
  const axisLabelW = 64;
  const slot = spec.type === 'bar' ? Math.max(48, series.length * 26 + 22) : 56;
  const plotW = Math.max(380, n * slot);
  const plotH = 280;
  const hasLegend = series.length > 1;
  const titleH = 34;
  const legendH = hasLegend ? 30 : 0;
  const xLabelH = 30;
  const footH = spec.source ? 24 : 0;
  const cardW = pad + axisLabelW + plotW + pad;
  const cardH = pad + titleH + legendH + 16 + plotH + xLabelH + footH + pad;
  const x0 = origin.x;
  const y0 = origin.y;
  const plotX = x0 + pad + axisLabelW;
  const plotY = y0 + pad + titleH + legendH + 16;
  const yOf = (v: number) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
  const text = (t: string, x: number, y: number, size: number, color: string, align?: 'center' | 'right') => {
    const el = makeText({
      ...common,
      text: t,
      x,
      y,
      fontSize: size,
      fontFamily: FONT.normal,
      strokeColor: color,
      textAlign: align ?? 'left',
    });
    if (align) anchors.set(el.id, { x, align });
    out.push(el);
    return el;
  };
  const line = (points: [number, number][], x: number, y: number, color: string, width = 1, style: 'solid' | 'dashed' = 'solid') => {
    const el = makeLine({ ...common, x, y, points, strokeColor: color, strokeWidth: width, strokeStyle: style });
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    el.width = Math.max(...xs) - Math.min(...xs);
    el.height = Math.max(...ys) - Math.min(...ys);
    out.push(el);
    return el;
  };

  // Card background.
  out.push(
    ...makeShape({
      ...common,
      x: x0,
      y: y0,
      width: cardW,
      height: cardH,
      backgroundColor: '#ffffff',
      strokeColor: '#dee2e6',
      customData: { ...customData, role: 'background' },
    }),
  );
  text(spec.title || 'Chart', x0 + pad, y0 + pad, 24, '#1e1e1e');

  if (hasLegend) {
    let lx = x0 + pad;
    const ly = y0 + pad + titleH + 4;
    series.forEach((s, i) => {
      out.push(
        ...makeShape({
          ...common,
          x: lx,
          y: ly + 3,
          width: 14,
          height: 14,
          backgroundColor: SERIES_COLORS[i]!,
          strokeColor: SERIES_COLORS[i]!,
          rounded: false,
        }),
      );
      const label = shorten(s.name, 24);
      text(label, lx + 20, ly, 16, '#495057');
      lx += 20 + label.length * 8.5 + 24;
    });
  }

  // Gridlines and value axis labels.
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = yOf(v);
    const isZero = Math.abs(v) < step / 1e6;
    line(
      [
        [0, 0],
        [plotW, 0],
      ],
      plotX,
      y,
      isZero ? '#868e96' : '#e9ecef',
      isZero ? 1.5 : 1,
    );
    text(formatValue(Number(v.toPrecision(12))), plotX - 10, y - 9, 14, '#868e96', 'right');
  }
  line(
    [
      [0, 0],
      [0, plotH],
    ],
    plotX,
    plotY,
    '#ced4da',
    1,
  );

  // Data.
  const zeroY = yOf(0);
  if (spec.type === 'bar') {
    const gap = 4;
    const bw = Math.min(40, (slot - 16 - gap * (series.length - 1)) / series.length);
    const groupW = bw * series.length + gap * (series.length - 1);
    for (let i = 0; i < n; i++) {
      series.forEach((_s, si) => {
        const v = values[si]![i];
        if (v === null || v === undefined) return;
        const bx = plotX + i * slot + (slot - groupW) / 2 + si * (bw + gap);
        const top = Math.min(yOf(v), zeroY);
        const h = Math.max(1, Math.abs(yOf(v) - zeroY));
        out.push(
          ...makeShape({
            ...common,
            x: bx,
            y: top,
            width: bw,
            height: h,
            backgroundColor: SERIES_COLORS[si]!,
            strokeColor: SERIES_COLORS[si]!,
            rounded: false,
          }),
        );
        if (series.length === 1 && n <= 20) {
          text(formatValue(v), bx + bw / 2, v >= 0 ? top - 20 : top + h + 4, 13, '#495057', 'center');
        }
      });
    }
  } else {
    series.forEach((_s, si) => {
      const pts = values[si]!.map((v, i) => (v === null || v === undefined ? null : ([plotX + i * slot + slot / 2, yOf(v)] as [number, number]))).filter(
        (p): p is [number, number] => p !== null,
      );
      if (!pts.length) return;
      const [fx, fy] = pts[0]!;
      if (pts.length > 1)
        line(
          pts.map(([px, py]) => [px - fx, py - fy] as [number, number]),
          fx,
          fy,
          SERIES_COLORS[si]!,
          2.5,
        );
      if (pts.length <= 30) {
        for (const [px, py] of pts) {
          out.push(
            ...makeShape({
              ...common,
              shape: 'ellipse',
              x: px - 5,
              y: py - 5,
              width: 10,
              height: 10,
              backgroundColor: SERIES_COLORS[si]!,
              strokeColor: SERIES_COLORS[si]!,
            }),
          );
        }
      }
    });
  }

  // Category labels (thinned out when there are many).
  const every = Math.ceil(n / 16);
  const maxChars = Math.max(4, Math.floor((slot * every) / 8));
  for (let i = 0; i < n; i += every) {
    text(shorten(labels[i]!, maxChars), plotX + i * slot + slot / 2, plotY + plotH + 8, 14, '#495057', 'center');
  }

  if (spec.source) {
    text(`Source: ${shorten(spec.source, 60)}${truncated ? ` (first ${MAX_CATEGORIES} rows)` : ''}`, x0 + pad, y0 + cardH - pad - 14, 12, '#adb5bd');
  }

  return { elements: out, groupId, anchors, truncated, width: cardW, height: cardH };
}
