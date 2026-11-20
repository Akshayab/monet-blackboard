// The pieces the board page mounts around the canvas, and the context they share:
//   TopRight   -> avatars/presence, share button, export menu, shown in the board's top bar
//   LeftPanel  -> the AI chat panel (left split, hidden until "Show chat")
//   PromptBar  -> the "Describe a change" bar in the bottom dock, above the tool pill
//   Children   -> extra Excalidraw children: floating toolbars, selection actions, dialogs
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { AuthUser, BoardRole, BoardSummary } from '@/lib/api';
import type { CollabApi } from './use-collab';
import { PresenceAvatars } from './presence';
import { AiChatPanel } from './ai/chat-panel';
import { AiPromptBar } from './ai/prompt-bar';
import { AiCanvasOverlays } from './ai/canvas-overlays';
import { ShareButton } from './share/share-button';
import { FollowBanner } from './share/follow-banner';
import { BoardInputs } from './inputs';
import { OutputsMenu } from './outputs/outputs-menu';
import { BoardChrome } from '@/components/board-chrome/board-chrome';
import { CommentLayer } from '@/components/board-shell/comments';
import { CursorChatLayer } from '@/components/board-shell/cursor-chat';
import { LiveEmbedChrome } from '@/components/board-shell/live-embed-chrome';

export interface BoardContext {
  boardId: string;
  linkToken: string | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  collab: CollabApi;
  board: BoardSummary | null;
  role: BoardRole | null;
  canEdit: boolean;
  user: AuthUser | null;
}

function TopRight({ ctx, isMobile }: { ctx: BoardContext; isMobile: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <PresenceAvatars ctx={ctx} compact={isMobile} />
      <ShareButton ctx={ctx} compact={isMobile} />
      <OutputsMenu ctx={ctx} compact={isMobile} />
    </div>
  );
}

function LeftPanel({ ctx }: { ctx: BoardContext }) {
  return <AiChatPanel ctx={ctx} />;
}

function PromptBar({ ctx }: { ctx: BoardContext }) {
  return <AiPromptBar ctx={ctx} />;
}

function Children({ ctx }: { ctx: BoardContext }) {
  return (
    <>
      <AiCanvasOverlays ctx={ctx} />
      <FollowBanner ctx={ctx} />
      {/* Canvas inputs: file drop/paste, video & link embeds, sketch clean-up, CSV charts, sticky notes. */}
      <BoardInputs ctx={ctx} />
      {/* Board chrome: title-bar layout, page-zoom lock, and the "?" shortcuts overlay. */}
      <BoardChrome excalidrawAPI={ctx.excalidrawAPI} />
      {/* Comment pins and their cards. */}
      <CommentLayer ctx={ctx} />
      {/* Cursor chat: "/" shows a short message beside your cursor for everyone. */}
      <CursorChatLayer ctx={ctx} />
      <LiveEmbedChrome api={ctx.excalidrawAPI} />
    </>
  );
}

export const BoardSlots = { TopRight, LeftPanel, PromptBar, Children };
