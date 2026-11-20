import { useState } from 'react';
import { Lock, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BoardContext } from '../slots';
import { ShareDialog } from './share-dialog';
import './share.css';

/** "Share" button for the board's top-right bar. Opens the share dialog (everyone can open it; actions depend on role). */
export function ShareButton({ ctx, compact }: { ctx: BoardContext; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const restricted = ctx.board ? ctx.board.linkAccess === 'none' : true;
  return (
    <>
      <Button size="sm" className="h-8 gap-1.5 shadow-sm" onClick={() => setOpen(true)} data-testid="button-share">
        {restricted && ctx.role === 'owner' ? <Lock className="h-3.5 w-3.5" /> : <Share2 className="h-3.5 w-3.5" />}
        {!compact && 'Share'}
      </Button>
      <ShareDialog ctx={ctx} open={open} onOpenChange={setOpen} />
    </>
  );
}
