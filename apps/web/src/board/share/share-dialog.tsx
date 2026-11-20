import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Globe, Link2, Lock, RefreshCw, UserMinus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ApiError, type BoardRole } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { BoardContext } from '../slots';
import { colorForId, PersonAvatar } from './person-avatar';
import { copyText, shareLinkUrl, sharingApi, type LinkAccess, type SharingState } from './sharing-api';

const ROLE_LABEL: Record<BoardRole, string> = { owner: 'Owner', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' };

const LINK_OPTIONS: { value: LinkAccess; label: string; hint: string }[] = [
  { value: 'none', label: 'Only you', hint: 'Turning the link off removes access for everyone who joined through it.' },
  { value: 'view', label: 'Anyone with the link can view', hint: 'People with the link enter a name and can see the board, but not change it.' },
  { value: 'edit', label: 'Anyone with the link can edit', hint: 'People with the link enter a name and can edit the board and use the AI.' },
];

function errMsg(err: unknown) {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

function RoleSelect({
  value,
  onChange,
  testId,
  onRemove,
}: {
  value: BoardRole;
  onChange: (v: 'editor' | 'commenter' | 'viewer') => void;
  testId: string;
  onRemove: () => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === 'remove') onRemove();
        else onChange(v as 'editor' | 'commenter' | 'viewer');
      }}
    >
      <SelectTrigger className="h-8 w-[112px] text-xs" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="editor">Can edit</SelectItem>
        <SelectItem value="commenter">Can comment</SelectItem>
        <SelectItem value="viewer">Can view</SelectItem>
        <SelectItem value="remove" className="text-destructive-text focus:text-destructive-text">
          Remove
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-xs"
      title={label}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast({ title: "Couldn't copy", description: text });
        }
      }}
      data-testid={testId}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function ShareDialog({ ctx, open, onOpenChange }: { ctx: BoardContext; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { boardId, linkToken } = ctx;
  const { toast } = useToast();
  const [data, setData] = useState<SharingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await sharingApi.get(boardId, linkToken));
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err));
    }
  }, [boardId, linkToken]);

  // Reload when opened, and when my own role changes live.
  useEffect(() => {
    if (open) void reload();
  }, [open, reload, ctx.role]);

  async function run(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) toast({ title: success });
    } catch (err) {
      toast({ title: errMsg(err), variant: 'destructive' });
    } finally {
      await reload();
    }
  }

  const perms = data?.permissions;
  const isOwner = !!perms?.canManage;
  const linkOn = data?.board.linkAccess && data.board.linkAccess !== 'none';
  const linkOption = LINK_OPTIONS.find((o) => o.value === (data?.board.linkAccess ?? 'none'))!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-0 gap-0 overflow-hidden" data-testid="dialog-share">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="truncate pr-6">Share “{data?.board.title ?? ctx.board?.title ?? 'board'}”</DialogTitle>
          <DialogDescription>
            {data && !data.teamMode
              ? 'Sharing is off because this server runs in solo mode.'
              : 'Share a link. People who open it enter a name and see edits live.'}
          </DialogDescription>
        </DialogHeader>

        {loadError && (
          <p className="px-6 pb-4 text-sm text-destructive-text" data-testid="text-share-error">
            {loadError}
          </p>
        )}

        {data && !data.teamMode && (
          <section className="px-6 pb-6" data-testid="text-share-solo">
            <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
              <p>
                Monet Blackboard is running for you alone on this computer. To brainstorm with other people, restart it with{' '}
                <code className="rounded bg-background px-1 py-px text-xs">TEAM_MODE=1</code> and make it reachable from their computers, for example with a
                tunnel or a small server.
              </p>
              <p className="mt-2">
                The README's <span className="font-medium text-foreground">Team mode</span> section walks through both.
              </p>
            </div>
          </section>
        )}

        {data && data.teamMode && (
          <div className="max-h-[70vh] overflow-y-auto">
            {/* Link */}
            <section className="px-6 pb-4">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-full',
                    linkOn ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {linkOn ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  {perms?.canChangeLink ? (
                    <Select value={data.board.linkAccess} onValueChange={(v) => void run(() => sharingApi.setLink(boardId, v as LinkAccess))}>
                      <SelectTrigger
                        className="h-8 w-full max-w-[280px] border-0 bg-transparent px-1 text-sm font-medium shadow-none focus:ring-0"
                        data-testid="select-link-access"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LINK_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-medium" data-testid="text-link-access">
                      {linkOption.label}
                    </div>
                  )}
                  <div className="px-1 text-xs text-muted-foreground">{linkOption.hint}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {linkOn && data.board.linkToken ? (
                  <>
                    <Input
                      readOnly
                      value={shareLinkUrl(data.board.linkToken)}
                      className="h-8 flex-1 min-w-[200px] bg-background text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                      data-testid="input-share-link"
                    />
                    <CopyButton text={shareLinkUrl(data.board.linkToken)} label="Copy link" testId="button-copy-link" />
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">{isOwner ? 'Turn on link sharing to get a link.' : 'Link sharing is off.'}</span>
                )}
                {isOwner && linkOn && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => {
                      if (
                        !confirm(
                          'Reset the link? The current link stops working, and everyone who joined through it loses access. People whose role you set keep it.',
                        )
                      )
                        return;
                      void run(() => sharingApi.regenerateLink(boardId), 'New link created');
                    }}
                    data-testid="button-regenerate-link"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Reset link
                  </Button>
                )}
              </div>
            </section>

            {/* People */}
            <section className="border-t px-6 py-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">People on this board</h3>
              <ul className="mt-2 space-y-1" data-testid="list-share-people">
                {data.owner && (
                  <li className="flex items-center gap-3 py-1.5" data-testid={`row-member-${data.owner.userId}`}>
                    <PersonAvatar name={data.owner.name} color={colorForId(data.owner.userId)} size={32} />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">
                      {data.owner.name}
                      {data.owner.userId === data.me.userId && <span className="text-muted-foreground font-normal"> (you)</span>}
                    </div>
                    <span className="text-xs text-muted-foreground pr-2">Owner</span>
                  </li>
                )}
                {data.members.map((m) => {
                  const isMe = m.userId === data.me.userId;
                  return (
                    <li key={m.userId} className="flex items-center gap-3 py-1.5" data-testid={`row-member-${m.userId}`}>
                      <PersonAvatar name={m.name} color={colorForId(m.userId)} size={32} />
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">
                        {m.name}
                        {isMe && <span className="text-muted-foreground font-normal"> (you)</span>}
                        {m.source === 'link' && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground align-middle">
                            <Link2 className="h-2.5 w-2.5" /> via link
                          </span>
                        )}
                      </div>
                      {isOwner ? (
                        <RoleSelect
                          value={m.role}
                          onChange={(role) => void run(() => sharingApi.setMemberRole(boardId, m.userId, role), `${m.name}: ${ROLE_LABEL[role].toLowerCase()}`)}
                          testId={`select-member-role-${m.userId}`}
                          onRemove={() => void run(() => sharingApi.removeMember(boardId, m.userId, linkToken), `Removed ${m.name}`)}
                        />
                      ) : isMe && m.source !== 'link' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{ROLE_LABEL[m.role]}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 text-xs"
                            onClick={() => {
                              if (!confirm('Leave this board? You’ll need its link to come back.')) return;
                              void sharingApi.removeMember(boardId, m.userId, linkToken).catch(() => undefined);
                            }}
                            data-testid="button-leave-board"
                          >
                            <UserMinus className="h-3.5 w-3.5" /> Leave
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground pr-2" data-testid={`text-member-role-${m.userId}`}>
                          {ROLE_LABEL[m.role]}
                        </span>
                      )}
                    </li>
                  );
                })}
                {!data.members.length && (
                  <li className="py-1.5 text-xs text-muted-foreground" data-testid="text-no-members">
                    Nobody else has joined yet.
                  </li>
                )}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
