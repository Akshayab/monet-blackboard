// Board templates offered in the library and on the landing page. The boards themselves are built on the
// server (artifacts/api-server/src/templates); keep these ids in sync with TEMPLATE_IDS there.
import type { ReactNode } from 'react';

export type TemplateId = 'retrospective' | 'launch-plan' | 'decision-matrix' | 'process-map' | 'brainstorm' | 'weekly-planning';

export interface TemplateMeta {
  id: TemplateId;
  name: string;
  description: string;
}

export const TEMPLATES: TemplateMeta[] = [
  { id: 'retrospective', name: 'Retrospective', description: 'Went well, to improve, and action items.' },
  { id: 'launch-plan', name: 'Product launch plan', description: 'Timeline lanes for each team, up to launch day.' },
  { id: 'decision-matrix', name: 'Decision matrix', description: 'Score options against the criteria that matter.' },
  { id: 'process-map', name: 'Process map', description: 'Steps, decisions, and connectors from start to done.' },
  { id: 'brainstorm', name: 'Brainstorm', description: 'A central topic with clusters of ideas around it.' },
  { id: 'weekly-planning', name: 'Weekly planning', description: 'Top priorities, a column per day, and a parking lot.' },
];

// Dark board palette (lib/board-protocol palette.ts).
const Y = '#f5d90a';
const B = '#5b9cf0';
const G = '#5fd35f';
const P = '#e8579f';
const O = '#f59e42';
const V = '#9b87f5';
// Theme-aware neutrals (CSS variables from index.css; SVG attributes don't resolve var(), so they go in style).
const INK = 'var(--monet-canvas)';
const LINE = 'var(--monet-tpl-line)';
const FRAME = 'var(--monet-tpl-frame)';
const CARD = 'var(--monet-tpl-card)';
const ARROW = 'var(--monet-tpl-arrow)';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 120 90" className="h-full w-full" aria-hidden="true" focusable="false">
      <rect width="120" height="90" style={{ fill: 'var(--monet-canvas)' }} />
      {children}
    </svg>
  );
}

const card = (x: number, y: number, w: number, h: number, fill: string, key?: string | number) => (
  <rect key={key} x={x} y={y} width={w} height={h} rx={2} style={{ fill, stroke: INK }} strokeWidth={0.6} />
);
const frame = (x: number, y: number, w: number, h: number, key?: string | number) => (
  <rect key={key} x={x} y={y} width={w} height={h} rx={3} style={{ fill: FRAME, stroke: LINE }} strokeWidth={0.8} />
);

/** Small schematic preview of a template, drawn to match the board it creates. */
export function TemplatePreview({ id }: { id: TemplateId }) {
  switch (id) {
    case 'retrospective':
      return (
        <Svg>
          {[G, P, B].map((c, i) => (
            <g key={i}>
              {frame(8 + i * 36, 14, 32, 64)}
              {card(12 + i * 36, 20, 11, 11, c)}
              {card(25 + i * 36, 20, 11, 11, c)}
              {card(12 + i * 36, 34, 11, 11, c)}
            </g>
          ))}
        </Svg>
      );
    case 'launch-plan':
      return (
        <Svg>
          {frame(6, 10, 108, 72)}
          {[B, P, G, O].map((c, i) => (
            <g key={i}>
              {card(10, 16 + i * 15, 14, 12, c)}
              <rect x={27} y={16 + i * 15} width={83} height={12} rx={2} style={{ fill: CARD, stroke: LINE }} strokeWidth={0.5} />
              {card(30 + ((i * 17) % 40), 18 + i * 15, 26, 8, c)}
              {card(62 + ((i * 11) % 20), 18 + i * 15, 18, 8, c)}
            </g>
          ))}
          <line x1={96} y1={14} x2={96} y2={78} stroke="#7048e8" strokeWidth={0.8} strokeDasharray="2 1.5" />
        </Svg>
      );
    case 'decision-matrix':
      return (
        <Svg>
          {frame(6, 10, 108, 72)}
          {[0, 1, 2, 3].map((r) =>
            [0, 1, 2, 3, 4].map((c) => (
              <rect
                key={`${r}-${c}`}
                x={12 + c * 19.5}
                y={16 + r * 13}
                width={c === 0 ? 19.5 : 19.5}
                height={13}
                style={{ fill: r === 0 ? (c === 4 ? G : c === 0 ? CARD : B) : c === 0 ? Y : c === 4 ? G : CARD, stroke: INK }}
                strokeWidth={0.5}
              />
            )),
          )}
          {card(12, 70, 97.5, 8, V)}
        </Svg>
      );
    case 'process-map':
      return (
        <Svg>
          {frame(4, 16, 112, 58)}
          <ellipse cx={18} cy={38} rx={10} ry={6} style={{ fill: G, stroke: INK }} strokeWidth={0.6} />
          {card(34, 32, 18, 12, B)}
          <polygon points="68,30 77,38 68,46 59,38" style={{ fill: Y, stroke: INK }} strokeWidth={0.6} />
          {card(84, 32, 18, 12, B)}
          {card(59, 56, 18, 11, P)}
          <g style={{ stroke: ARROW }} strokeWidth={0.7} fill="none">
            <path d="M28 38h5" />
            <path d="M52 38h6" />
            <path d="M77 38h6" />
            <path d="M68 46v9" />
          </g>
        </Svg>
      );
    case 'brainstorm':
      return (
        <Svg>
          <g style={{ stroke: ARROW }} strokeWidth={0.6}>
            <path d="M52 41L30 24" />
            <path d="M68 41L90 24" />
            <path d="M52 50L30 66" />
            <path d="M68 50L90 66" />
          </g>
          <ellipse cx={60} cy={45} rx={15} ry={8} style={{ fill: V, stroke: INK }} strokeWidth={0.6} />
          {[
            [16, 18, Y],
            [80, 18, B],
            [16, 62, P],
            [80, 62, G],
          ].map(([x, y, c], i) => (
            <g key={i}>
              {card(x as number, y as number, 22, 8, CARD)}
              {card((x as number) - 2, (y as number) < 40 ? (y as number) - 13 : (y as number) + 11, 11, 11, c as string)}
              {card((x as number) + 12, (y as number) < 40 ? (y as number) - 13 : (y as number) + 11, 11, 11, c as string)}
            </g>
          ))}
        </Svg>
      );
    case 'weekly-planning':
      return (
        <Svg>
          {frame(6, 10, 22, 52)}
          {card(9, 15, 16, 9, Y)}
          {card(9, 27, 16, 9, Y)}
          {card(9, 39, 16, 9, Y)}
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              {frame(31 + i * 17, 10, 15, 52)}
              {i !== 2 && card(33 + i * 17, 14, 11, 8, B)}
            </g>
          ))}
          {frame(6, 66, 110, 16)}
          {card(9, 69, 14, 10, O)}
        </Svg>
      );
  }
}
