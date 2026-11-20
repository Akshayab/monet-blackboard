import { useState } from 'react';
import { Eye, Users } from 'lucide-react';
import type { Collaborator } from '@monet/board-protocol';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BoardContext } from './slots';
import { PersonAvatar } from './share/person-avatar';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' } as const;

/** One entry per person (a person may have several tabs open); the AI last. */
function uniquePeople(list: Collaborator[]) {
  const seen = new Set<string>();
  const people = list.filter((c) => (seen.has(c.userId) ? false : (seen.add(c.userId), true)));
  return [...people.filter((c) => !c.isAI), ...people.filter((c) => c.isAI)];
}

/**
 * Avatars of everyone on the board (top right). Click someone to follow their view; click again to stop.
 * The "who's here" list shows everyone with their role, who follows whom, and follow buttons.
 */
export function PresenceAvatars({ ctx, compact }: { ctx: BoardContext; compact?: boolean }) {
  const { collab } = ctx;
  const meId = collab.me?.socketId;
  const others = uniquePeople(collab.collaborators.filter((c) => c.socketId !== meId && c.userId !== collab.me?.userId));
  const shown = others.slice(0, compact ? 2 : 4);
  const aiBusy = collab.aiRun?.status === 'thinking' || collab.aiRun?.status === 'drawing';
  const followerNames = collab.followers.map((id) => collab.collaborators.find((c) => c.socketId === id)?.name).filter((n): n is string => !!n);

  return (
    <div className="flex items-center gap-1.5" data-testid="presence-avatars">
      <div className="flex items-center -space-x-1.5">
        {shown.map((c) => {
          const following = collab.following === c.socketId;
          const followsMe = collab.followers.includes(c.socketId);
          return (
            <Tooltip key={c.socketId}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => collab.follow(following ? null : c.socketId)}
                  className={cn(
                    'relative rounded-full border-2 border-white shadow-sm transition hover:z-10 hover:-translate-y-0.5',
                    following && 'z-10 ring-2 ring-offset-1',
                  )}
                  style={following ? ({ '--tw-ring-color': c.isAI ? '#5c5ce0' : c.color } as React.CSSProperties) : undefined}
                  data-testid={c.isAI ? 'avatar-ai' : `avatar-${c.userId}`}
                  aria-label={`${c.name}${following ? ', following' : ''}`}
                >
                  <PersonAvatar name={c.name} color={c.color} imageUrl={c.avatarUrl} isAI={c.isAI} busy={c.isAI && aiBusy} size={30} />
                  {(c.role === 'viewer' || c.role === 'commenter') && !c.isAI && (
                    <span className="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-white text-muted-foreground shadow">
                      <Eye className="h-2.5 w-2.5" />
                    </span>
                  )}
                  {followsMe && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs opacity-80">
                  {c.isAI
                    ? aiBusy
                      ? 'Working on the board · click to follow'
                      : 'Board AI · click to follow its cursor'
                    : `${ROLE_LABEL[c.role]}${followsMe ? ' · following you' : ''} · ${following ? 'click to stop following' : 'click to follow'}`}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <WhoIsHere ctx={ctx} people={others} aiBusy={aiBusy} overflow={others.length - shown.length} followerNames={followerNames} />
    </div>
  );
}

function WhoIsHere({
  ctx,
  people,
  aiBusy,
  overflow,
  followerNames,
}: {
  ctx: BoardContext;
  people: Collaborator[];
  aiBusy: boolean;
  overflow: number;
  followerNames: string[];
}) {
  const { collab } = ctx;
  const [open, setOpen] = useState(false);
  const me = collab.me;
  const humans = people.filter((p) => !p.isAI).length + (me ? 1 : 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full bg-white px-2.5 text-xs shadow-sm" data-testid="button-who-is-here">
          <Users className="h-3.5 w-3.5" />
          {overflow > 0 ? `+${overflow}` : humans}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="popover-who-is-here">
        <div className="border-b px-3 py-2">
          <div className="text-sm font-medium">On this board now</div>
          <div className="text-xs text-muted-foreground">
            {humans === 1 ? 'Just you' : `${humans} people`}
            {people.some((p) => p.isAI) ? ' and the AI' : ''}
            {followerNames.length ? ` · ${followerNames.join(', ')} following you` : ''}
          </div>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {me && (
            <li className="flex items-center gap-2.5 px-3 py-1.5" data-testid="row-here-me">
              <PersonAvatar name={me.name} color={me.color} imageUrl={me.avatarUrl} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {me.name} <span className="text-muted-foreground">(you)</span>
                </div>
                <div className="text-xs text-muted-foreground">{ROLE_LABEL[collab.role ?? me.role]}</div>
              </div>
            </li>
          )}
          {people.map((c) => {
            const following = collab.following === c.socketId;
            const followsMe = collab.followers.includes(c.socketId);
            return (
              <li key={c.socketId} className="flex items-center gap-2.5 px-3 py-1.5" data-testid={c.isAI ? 'row-here-ai' : `row-here-${c.userId}`}>
                <PersonAvatar name={c.name} color={c.color} imageUrl={c.avatarUrl} isAI={c.isAI} busy={c.isAI && aiBusy} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.isAI ? (aiBusy ? (collab.aiRun?.status === 'thinking' ? 'Thinking…' : 'Drawing…') : 'Board AI') : ROLE_LABEL[c.role]}
                    {followsMe ? ' · following you' : ''}
                  </div>
                </div>
                <Button
                  variant={following ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    collab.follow(following ? null : c.socketId);
                    setOpen(false);
                  }}
                  data-testid={c.isAI ? 'button-follow-ai' : `button-follow-${c.userId}`}
                >
                  {following ? 'Stop' : 'Follow'}
                </Button>
              </li>
            );
          })}
          {people.length === 0 && <li className="px-3 py-3 text-xs text-muted-foreground">Nobody else is here. Share the board to invite people.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
