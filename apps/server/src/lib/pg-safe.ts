// Postgres can't store NUL characters or unpaired UTF-16 surrogates (half of an emoji) in text or jsonb: one such
// character makes the whole write fail. Text pasted from PDFs and terminals carries NULs, and cutting a string in the
// middle of an emoji leaves a lone surrogate. Strip NULs and replace lone surrogates with U+FFFD before storing.
const BAD = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BAD_ALL = new RegExp(BAD.source, "g");

export function pgSafeText(s: string): string {
  return BAD.test(s) ? s.replace(BAD_ALL, (m) => (m === "\u0000" ? "" : "\uFFFD")) : s;
}

function define(o: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** How deeply JSON values may nest. Nothing the app sends comes close; deeper input is refused, not recursed into. */
export const MAX_JSON_DEPTH = 64;

export class JsonTooDeepError extends Error {
  status = 400;
  code = "too_deep";
  constructor() {
    super(`JSON nested more than ${MAX_JSON_DEPTH} levels deep.`);
  }
}

/** Cleans every string (and object key) in a JSON value. Returns the same reference when nothing changed. */
export function pgSafe<T>(value: T, depth = 0): T {
  if (typeof value === "string") return pgSafeText(value) as T;
  if (value && typeof value === "object" && depth >= MAX_JSON_DEPTH) throw new JsonTooDeepError();
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v = pgSafe(value[i], depth + 1);
      if (v !== value[i]) (out ??= value.slice())[i] = v;
    }
    return (out ?? value) as T;
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(src)) {
      const v = pgSafe(src[key], depth + 1);
      const k = pgSafeText(key);
      if (v === src[key] && k === key) continue;
      if (!out) {
        out = {};
        for (const k0 of Object.keys(src)) define(out, k0, src[k0]);
      }
      if (k !== key) delete out[key];
      define(out, k, v);
    }
    return (out ?? value) as T;
  }
  return value;
}
