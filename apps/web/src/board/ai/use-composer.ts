// Shared input logic for the prompt bar and the chat panel's Reply box: draft, dictation (Esc or the mic
// again stops, words stay, Return sends), attachments (button, paste, drop), and the selection focus chip.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import {
  AttachmentError,
  MAX_ATTACHMENTS,
  MAX_TOTAL_CHARS,
  readAttachment,
  toRequestAttachment,
  type AiAttachment,
  type PendingAttachment,
} from './attachments';
import { useDictation } from './use-dictation';

export interface ComposerSendInput {
  prompt: string;
  attachments: AiAttachment[];
  focusElementIds: string[];
}

export function joinText(a: string, b: string) {
  if (!b) return a;
  if (!a) return b;
  return /\s$/.test(a) ? a + b : `${a} ${b}`;
}

export interface ComposerOptions {
  focusIds: string[];
  focusCount: number;
  disabled: boolean;
  /** When set, typing still works but sending is off (e.g. the AI is paused). */
  blockedReason?: string | null;
  sending: boolean;
  /** Dictation is unavailable while a live session holds the microphone. */
  micBusy: boolean;
  onSend: (input: ComposerSendInput) => Promise<boolean>;
  /** Focus the input when this number changes (prompt bar only). */
  focusRequest?: number;
  maxHeight?: number;
}

export function useComposer(o: ComposerOptions) {
  const { focusIds, focusCount, disabled, blockedReason, sending, micBusy, onSend } = o;
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const focusKey = focusIds.join(',');
  const [ignoredFocusKey, setIgnoredFocusKey] = useState<string | null>(null);
  const useFocus = focusCount > 0 && ignoredFocusKey !== focusKey;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dictation = useDictation({ onFinal: (t) => setDraft((d) => joinText(d, t)) });

  // Focus requests (toolbar "Ask AI", floating "Ask AI" on a selection).
  const focusRequest = o.focusRequest ?? 0;
  useEffect(() => {
    if (focusRequest > 0) {
      setIgnoredFocusKey(null);
      textareaRef.current?.focus();
      requestAnimationFrame(() => {
        if (document.activeElement !== textareaRef.current) textareaRef.current?.focus();
      });
    }
  }, [focusRequest]);

  // Auto-size the textarea.
  const maxHeight = o.maxHeight ?? 160;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!el.scrollHeight) {
      el.style.height = '';
      return;
    }
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft, dictation.interim, focusRequest, maxHeight]);

  // Escape stops dictation wherever focus is.
  useEffect(() => {
    if (!dictation.listening) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dictation.stop();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dictation, dictation.listening]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      if (!list.length) return;
      setAttachError(null);
      const room = MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        setAttachError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }
      setReading((n) => n + 1);
      try {
        const read: PendingAttachment[] = [];
        const errors: string[] = [];
        for (const f of list.slice(0, room)) {
          try {
            read.push(await readAttachment(f));
          } catch (err) {
            errors.push(err instanceof AttachmentError ? err.message : `Couldn't read ${f.name}.`);
          }
        }
        if (list.length > room) errors.push(`Only ${MAX_ATTACHMENTS} files can be attached.`);
        setAttachments((prev) => {
          const next = [...prev];
          let total = next.reduce((s, a) => s + a.size, 0);
          for (const a of read) {
            if (total + a.size > MAX_TOTAL_CHARS) {
              errors.push(`${a.name} would make the request too large.`);
              continue;
            }
            total += a.size;
            next.push(a);
          }
          return next;
        });
        if (errors.length) setAttachError(errors.join(' '));
      } finally {
        setReading((n) => n - 1);
      }
    },
    [attachments.length],
  );

  const submit = useCallback(async () => {
    if (disabled || blockedReason || sending || reading) return;
    let text = draft;
    if (dictation.listening) text = joinText(text, dictation.cancel());
    text = text.trim();
    if (!text && attachments.length) text = attachments.length === 1 ? 'Turn this file into a structured board.' : 'Turn these files into a structured board.';
    if (!text) return;
    // Clear right away; put everything back if the send fails and the user hasn't typed something new.
    const sentAttachments = attachments;
    setDraft('');
    setAttachments([]);
    setAttachError(null);
    const ok = await onSend({ prompt: text, attachments: sentAttachments.map(toRequestAttachment), focusElementIds: useFocus ? focusIds : [] });
    if (!ok) {
      setDraft((d) => (d.trim() ? d : text));
      setAttachments((a) => (a.length ? a : sentAttachments));
    }
  }, [attachments, blockedReason, dictation, disabled, draft, focusIds, onSend, reading, sending, useFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      if (dictation.listening) {
        e.preventDefault();
        dictation.stop();
      } else textareaRef.current?.blur();
      e.stopPropagation();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (!disabled && e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
    },
  };

  const value = dictation.listening && dictation.interim ? joinText(draft, dictation.interim) : draft;
  const onChange = (v: string) => {
    // While dictating, the in-progress phrase is shown inline; keep only what the user typed.
    if (dictation.listening && dictation.interim) {
      const suffix = dictation.interim;
      setDraft(v.endsWith(suffix) ? v.slice(0, v.length - suffix.length).trimEnd() : v);
    } else setDraft(v);
  };

  const toggleMic = () => {
    dictation.clearError();
    if (dictation.listening) dictation.stop();
    else {
      dictation.start();
      textareaRef.current?.focus();
    }
  };

  const micDisabled = disabled || micBusy || !dictation.supported;
  const micLabel = !dictation.supported
    ? "Dictation isn't supported in this browser"
    : micBusy
      ? 'The live session is using the microphone'
      : dictation.listening
        ? 'Stop dictation (Esc)'
        : 'Dictate';
  const hasContent = !!(draft.trim() || dictation.interim || attachments.length);
  const canSend = !disabled && !blockedReason && !sending && !reading && hasContent;

  return {
    draft,
    value,
    onChange,
    attachments,
    removeAttachment: (id: string) => setAttachments((prev) => prev.filter((x) => x.id !== id)),
    addFiles,
    attachError,
    reading,
    dragOver,
    dropProps,
    dictation,
    toggleMic,
    micDisabled,
    micLabel,
    useFocus,
    clearFocus: () => setIgnoredFocusKey(focusKey),
    submit,
    onKeyDown,
    onPaste,
    textareaRef,
    fileRef,
    hasContent,
    canSend,
  };
}

export type Composer = ReturnType<typeof useComposer>;
