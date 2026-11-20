// Dictation through the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition).
// Recognition follows the browser language (navigator.language). Final phrases are delivered through
// onFinal; the in-progress phrase is exposed as `interim`.
import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechAlternative;
  length: number;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResult };
}
interface SpeechErrorEvent {
  error: string;
  message?: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function dictationLanguage() {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

function errorMessage(code: string): string | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it in your browser to dictate.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Dictation needs a network connection.';
    case 'language-not-supported':
      return `Dictation isn't available for ${dictationLanguage()} in this browser.`;
    case 'no-speech':
    case 'aborted':
      return null;
    default:
      return 'Dictation stopped unexpectedly.';
  }
}

export interface DictationOptions {
  /** Keep listening across pauses and restart automatically when the browser ends the session. */
  continuous?: boolean;
  onFinal: (text: string) => void;
}

export function useDictation({ continuous = false, onFinal }: DictationOptions) {
  const supported = getSpeechRecognition() !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const interimRef = useRef('');

  const create = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = dictationLanguage();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0]?.transcript ?? '';
        if (r.isFinal) {
          const t = text.trim();
          if (t) onFinalRef.current(t);
        } else live += text;
      }
      interimRef.current = live.trim();
      setInterim(interimRef.current);
    };
    rec.onerror = (e) => {
      const msg = errorMessage(e.error);
      if (msg) setError(msg);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture' || e.error === 'language-not-supported') {
        wantRef.current = false;
      }
    };
    rec.onend = () => {
      // Browsers end sessions after silence; continuous mode restarts while the user still wants it.
      if (wantRef.current && continuous && recRef.current === rec) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through */
        }
      }
      if (recRef.current === rec) recRef.current = null;
      wantRef.current = false;
      interimRef.current = '';
      setInterim('');
      setListening(false);
    };
    return rec;
  }, [continuous]);

  const start = useCallback(() => {
    if (recRef.current) return;
    const rec = create();
    if (!rec) {
      setError("Dictation isn't supported in this browser. Try Chrome, Edge, or Safari.");
      return;
    }
    setError(null);
    wantRef.current = true;
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      wantRef.current = false;
      setError("Couldn't start dictation.");
    }
  }, [create]);

  /** Stops listening; the browser delivers any last phrase through onFinal. */
  const stop = useCallback(() => {
    wantRef.current = false;
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
  }, []);

  /** Stops immediately and drops anything not yet final. Returns the dropped interim text. */
  const cancel = useCallback(() => {
    wantRef.current = false;
    const rec = recRef.current;
    const pending = interimRef.current;
    recRef.current = null;
    interimRef.current = '';
    setInterim('');
    setListening(false);
    if (rec) {
      rec.onresult = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    return pending;
  }, []);

  useEffect(
    () => () => {
      wantRef.current = false;
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.onresult = null;
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  return { supported, listening, interim, error, clearError: () => setError(null), start, stop, cancel };
}
