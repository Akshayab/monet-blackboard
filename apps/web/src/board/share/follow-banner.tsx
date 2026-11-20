import { Eye, X } from 'lucide-react';
import type { BoardContext } from '../slots';
import { PersonAvatar } from './person-avatar';
import './share.css';

/**
 * Follow mode overlay: a colored frame + "Following X" banner with a stop button while you follow someone,
 * and a small "X is following you" note while others follow you. Panning, zooming, or clicking the canvas
 * also stops following (Excalidraw's built-in behavior, mirrored in use-collab).
 */
export function FollowBanner({ ctx }: { ctx: BoardContext }) {
  const { collab } = ctx;
  const target = collab.following ? collab.collaborators.find((c) => c.socketId === collab.following) : null;
  const followers = collab.followers.map((id) => collab.collaborators.find((c) => c.socketId === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const color = target ? (target.isAI ? '#5c5ce0' : target.color) : undefined;

  return (
    <>
      {target && (
        <div className="monet-follow-frame" style={{ borderColor: color }} data-testid="follow-frame">
          <div className="monet-follow-banner" style={{ backgroundColor: color }} data-testid="banner-following">
            <PersonAvatar name={target.name} color={target.color} imageUrl={target.avatarUrl} isAI={target.isAI} size={20} className="ring-2 ring-white/70" />
            <span className="truncate">
              Following <strong data-testid="text-following-name">{target.name}</strong>
            </span>
            <button
              type="button"
              onClick={() => collab.follow(null)}
              className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium hover:bg-white/30"
              data-testid="button-stop-following"
            >
              <X className="h-3 w-3" /> Stop
            </button>
          </div>
        </div>
      )}
      {!target && followers.length > 0 && (
        <div className="monet-followed-note" data-testid="note-followed-by">
          <Eye className="h-3.5 w-3.5" />
          {followers.length === 1 ? `${followers[0]!.name} is following your view` : `${followers.length} people are following your view`}
        </div>
      )}
    </>
  );
}
