import { Sparkles } from 'lucide-react';
import { PRESENCE_COLORS } from '@monet/board-protocol';
import { cn } from '@/lib/utils';

export function initialsOf(name: string) {
  const words = name
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function colorForId(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

/**
 * Round avatar: photo, else initials on the person's color. The AI gets a distinct gradient + sparkle,
 * and a soft pulse while it's working.
 */
export function PersonAvatar({
  name,
  color,
  imageUrl,
  isAI,
  busy,
  size = 32,
  className,
}: {
  name: string;
  color?: string;
  imageUrl?: string | null;
  isAI?: boolean;
  busy?: boolean;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) };
  if (isAI) {
    return (
      <span
        className={cn(
          'relative inline-grid place-items-center rounded-full text-white shrink-0 bg-[conic-gradient(from_200deg,#5c5ce0,#b04ce0,#ff7a59,#5c5ce0)]',
          busy && 'monet-ai-busy',
          className,
        )}
        style={style}
        aria-label={name}
      >
        <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />
      </span>
    );
  }
  return (
    <span
      className={cn('relative inline-grid place-items-center rounded-full font-semibold text-white shrink-0 overflow-hidden select-none', className)}
      style={{ ...style, backgroundColor: color ?? '#6b7280' }}
      aria-label={name}
    >
      {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : initialsOf(name)}
    </span>
  );
}
