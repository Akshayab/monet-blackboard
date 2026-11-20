// Live session (meetings): continuous dictation whose transcript is sent to the AI in chunks with
// mode "live", so the board builds while people talk.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDictation } from './use-dictation';

/** Send a chunk after about this much speech. */
export const LIVE_CHUNK_MS = 25_000;
/** If the AI is still busy, wait at most this long before sending anyway. */
const MAX_CHUNK_MS = 60_000;
const MIN_WORDS = 4;

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function useLiveSession(opts: { sendChunk: (text: string) => Promise<boolean>; aiBusy: boolean }) {
  const [active, setActive] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [buffer, setBuffer] = useState('');
  const [chunksSent, setChunksSent] = useState(0);
  const [sendingChunk, setSendingChunk] = useState(false);
  const bufferRef = useRef<string[]>([]);
  const chunkStartRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const busyRef = useRef(opts.aiBusy);
  busyRef.current = opts.aiBusy;
  const sendRef = useRef(opts.sendChunk);
  sendRef.current = opts.sendChunk;
  const flushingRef = useRef(false);

  const dictation = useDictation({
    continuous: true,
    onFinal: (text) => {
      if (!chunkStartRef.current) chunkStartRef.current = Date.now();
      bufferRef.current.push(text);
      setBuffer(bufferRef.current.join(' '));
    },
  });

  const flush = useCallback(
    async (force = false) => {
      if (flushingRef.current) return;
      const text = bufferRef.current.join(' ').trim();
      if (wordCount(text) < (force ? 1 : MIN_WORDS)) return;
      flushingRef.current = true;
      bufferRef.current = [];
      chunkStartRef.current = null;
      setBuffer('');
      setSendingChunk(true);
      try {
        const ok = await sendRef.current(text);
        if (ok) setChunksSent((n) => n + 1);
        else if (activeRef.current) {
          // Limit reached or AI unavailable: stop listening rather than piling up transcript.
          activeRef.current = false;
          setActive(false);
          dictation.cancel();
        }
      } finally {
        flushingRef.current = false;
        setSendingChunk(false);
      }
    },
    [dictation],
  );

  // Chunk timer.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const started = chunkStartRef.current;
      if (!started) return;
      const age = Date.now() - started;
      if (age >= MAX_CHUNK_MS || (age >= LIVE_CHUNK_MS && !busyRef.current)) void flush();
    }, 2000);
    return () => clearInterval(t);
  }, [active, flush]);

  // If dictation dies (permission denied, no mic), end the session.
  useEffect(() => {
    if (active && dictation.error && !dictation.listening) {
      activeRef.current = false;
      setActive(false);
    }
  }, [active, dictation.error, dictation.listening]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    bufferRef.current = [];
    chunkStartRef.current = null;
    setBuffer('');
    setChunksSent(0);
    activeRef.current = true;
    setActive(true);
    setStartedAt(Date.now());
    dictation.start();
  }, [dictation]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    dictation.stop();
    // Give the browser a moment to deliver the last phrase, then send what's left.
    setTimeout(() => void flush(true), 900);
  }, [dictation, flush]);

  return {
    supported: dictation.supported,
    active,
    startedAt,
    listening: dictation.listening,
    transcript: [buffer, dictation.interim].filter(Boolean).join(' '),
    chunksSent,
    sendingChunk,
    error: dictation.error,
    clearError: dictation.clearError,
    start,
    stop,
    toggle: () => (activeRef.current ? stop() : start()),
  };
}

export type LiveSession = ReturnType<typeof useLiveSession>;
