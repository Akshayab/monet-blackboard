// Compact tool pill under the prompt bar (select, hand, text, frame, sticky, pencil, shape,
// stickers, comment, then the AI button). Every button drives Excalidraw's active tool, so keyboard shortcuts
// and the pill stay in sync.
import { useState, type ReactNode } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import {
  ArrowRight,
  ChevronUp,
  Circle,
  Diamond,
  Eraser,
  Hand,
  Hash,
  Image as ImageIcon,
  MessageCircle,
  Minus,
  MousePointer2,
  Pencil,
  Smile,
  Square,
  StickyNote,
  Type,
} from 'lucide-react';
import { ShellMenu, ShellMenuItem } from './shell-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSceneState } from '@/board/inputs/use-scene-state';
import { STICKY_TOOL, useRegisterStickyPill } from '@/board/inputs/sticky-tool';
import { aiUi } from '@/board/ai/store';
import { activateSticker, STICKER_TOOL, STICKERS, stickerState, useStickerTool } from './stickers';
import { activateComment, COMMENT_TOOL, startCommentPlacement, useCommentPlacing } from './comments';

type ToolType = 'selection' | 'hand' | 'text' | 'frame' | 'freedraw' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'image' | 'eraser';
const SHAPES: { type: ToolType; label: string; key: string; icon: ReactNode; testId: string }[] = [
  { type: 'rectangle', label: 'Rectangle', key: 'R', icon: <Square className="h-4 w-4" />, testId: 'menu-tool-rectangle' },
  { type: 'ellipse', label: 'Ellipse', key: 'O', icon: <Circle className="h-4 w-4" />, testId: 'menu-tool-ellipse' },
  { type: 'diamond', label: 'Diamond', key: 'D', icon: <Diamond className="h-4 w-4" />, testId: 'menu-tool-diamond' },
  { type: 'arrow', label: 'Arrow', key: 'A', icon: <ArrowRight className="h-4 w-4" />, testId: 'menu-tool-arrow' },
  { type: 'line', label: 'Line', key: 'L', icon: <Minus className="h-4 w-4" />, testId: 'menu-tool-line' },
  { type: 'image', label: 'Image', key: '9', icon: <ImageIcon className="h-4 w-4" />, testId: 'menu-tool-image' },
  { type: 'eraser', label: 'Eraser', key: 'E', icon: <Eraser className="h-4 w-4" />, testId: 'menu-tool-eraser' },
];

function ToolButton({
  label,
  shortcut,
  active,
  onClick,
  testId,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition',
            active
              ? 'bg-[var(--monet-active-bg)] text-[var(--monet-active-fg)]'
              : 'text-[var(--monet-text-soft)] hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]',
          )}
          data-testid={testId}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="monet-dark-tooltip">
        {label}
        {shortcut && <span className="ml-1.5 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-[var(--monet-border-2)]" />;

export function ToolPill({
  api,
  canEdit,
  canComment = false,
  isMobile,
}: {
  api: ExcalidrawImperativeAPI | null;
  canEdit: boolean;
  /** Commenters: view-only board plus the comment tool. */
  canComment?: boolean;
  isMobile: boolean;
}) {
  const scene = useSceneState(api);
  const [lastShape, setLastShape] = useState<ToolType>('rectangle');
  const [pickerOpen, setPickerOpen] = useState(false);
  useStickerTool(api);
  useRegisterStickyPill();
  const placing = useCommentPlacing();
  if (!api || !scene) return null;
  const tool = scene.app.activeTool;
  const custom = tool.type === 'custom' ? tool.customType : null;
  const is = (t: ToolType) => tool.type === t;
  const set = (t: ToolType) => {
    setPickerOpen(false);
    api.setActiveTool({ type: t } as never);
  };
  const toggleCustom = (name: string, activate: () => void) => {
    setPickerOpen(false);
    if (custom === name) api.setActiveTool({ type: 'selection' });
    else activate();
  };
  const shapeActive = SHAPES.some((s) => s.type === tool.type);
  const shownShape = SHAPES.find((s) => s.type === (shapeActive ? tool.type : lastShape)) ?? SHAPES[0]!;
  const stickerActive = custom === STICKER_TOOL;

  return (
    <div className="relative flex max-w-full justify-center" data-monet-tool-pill="">
      {pickerOpen && canEdit && (
        <div
          className="pointer-events-auto absolute bottom-full z-10 mb-2 grid grid-cols-6 gap-1 rounded-xl border border-[var(--monet-border-2)] bg-[var(--monet-surface)] p-2 shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
          role="listbox"
          aria-label="Stickers"
          data-testid="picker-stickers"
        >
          {STICKERS.map((s, i) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={stickerActive && stickerState.get() === s}
              className={cn(
                'grid h-9 w-9 place-items-center rounded-lg text-xl hover:bg-[var(--monet-hover)]',
                stickerActive && stickerState.get() === s && 'bg-[var(--monet-active-bg)]',
              )}
              onClick={() => {
                activateSticker(api, s);
                setPickerOpen(false);
              }}
              data-testid={`sticker-${i}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-0.5 rounded-xl border border-[var(--monet-border)] bg-[var(--monet-surface)] p-1 shadow-[0_6px_24px_rgba(0,0,0,0.35)]',
          isMobile && 'max-w-full overflow-x-auto',
        )}
        role="toolbar"
        aria-label="Board tools"
        data-testid="tool-pill"
      >
        <ToolButton label="Select" shortcut="V" active={is('selection')} onClick={() => set('selection')} testId="tool-select">
          <MousePointer2 className="h-4 w-4" />
        </ToolButton>
        <ToolButton label="Hand (pan)" shortcut="H" active={is('hand')} onClick={() => set('hand')} testId="tool-hand">
          <Hand className="h-4 w-4" />
        </ToolButton>
        {canEdit && (
          <>
            <Divider />
            <ToolButton label="Text" shortcut="T" active={is('text')} onClick={() => set('text')} testId="tool-text">
              <Type className="h-4 w-4" />
            </ToolButton>
            <ToolButton label="Section" shortcut="F" active={is('frame')} onClick={() => set('frame')} testId="tool-frame">
              <Hash className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label="Sticky note"
              shortcut="N"
              active={custom === STICKY_TOOL}
              onClick={() =>
                toggleCustom(STICKY_TOOL, () => {
                  api.setActiveTool({ type: 'custom', customType: STICKY_TOOL });
                  api.setCursor('crosshair');
                })
              }
              testId="tool-sticky"
            >
              <StickyNote className="h-4 w-4" />
            </ToolButton>
            <ToolButton label="Pencil" shortcut="P" active={is('freedraw')} onClick={() => set('freedraw')} testId="tool-pencil">
              <Pencil className="h-4 w-4" />
            </ToolButton>
            <div className="flex items-center">
              <ToolButton
                label={shownShape.label}
                shortcut={shownShape.key}
                active={shapeActive}
                onClick={() => set(shownShape.type)}
                testId={shownShape.type === 'rectangle' ? 'tool-rectangle' : `tool-${shownShape.type}`}
              >
                {shownShape.icon}
              </ToolButton>
              <ShellMenu
                side="top"
                align="center"
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    className="grid h-8 w-4 place-items-center rounded-md text-[var(--monet-text-muted)] hover:bg-[var(--monet-hover)] hover:text-[var(--monet-text-strong)]"
                    aria-label="More shapes"
                    aria-haspopup="menu"
                    data-testid="tool-shapes"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                )}
              >
                {(close) =>
                  SHAPES.map((s) => (
                    <ShellMenuItem
                      key={s.type}
                      onSelect={() => {
                        setLastShape(s.type);
                        set(s.type);
                        close();
                      }}
                      shortcut={s.key}
                      testId={s.testId}
                    >
                      {s.icon}
                      {s.label}
                    </ShellMenuItem>
                  ))
                }
              </ShellMenu>
            </div>
            <ToolButton
              label="Stickers"
              active={stickerActive || pickerOpen}
              onClick={() => {
                if (stickerActive) {
                  api.setActiveTool({ type: 'selection' });
                  setPickerOpen(false);
                } else setPickerOpen((o) => !o);
              }}
              testId="tool-sticker"
            >
              <Smile className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              label="Comment"
              shortcut="C"
              active={custom === COMMENT_TOOL}
              onClick={() => toggleCustom(COMMENT_TOOL, () => activateComment(api))}
              testId="tool-comment"
            >
              <MessageCircle className="h-4 w-4" />
            </ToolButton>
            {/* Phones show the prompt bar right above this pill, and the extra button only overflowed the pill. */}
            {!isMobile && <Divider />}
            <button
              type="button"
              hidden={isMobile}
              onClick={() => aiUi.focusPrompt()}
              className="h-8 shrink-0 rounded-lg bg-[var(--monet-active-bg)] px-3 text-[13px] font-medium text-[var(--monet-active-fg)] transition hover:bg-[var(--monet-active-hover-bg)] hover:text-[var(--monet-active-hover-fg)]"
              data-testid="button-ask-ai"
            >
              Ask AI
            </button>
          </>
        )}
        {!canEdit && canComment && (
          <>
            <Divider />
            <ToolButton label="Comment" shortcut="C" active={placing} onClick={() => startCommentPlacement(!placing)} testId="tool-comment">
              <MessageCircle className="h-4 w-4" />
            </ToolButton>
          </>
        )}
      </div>
    </div>
  );
}
