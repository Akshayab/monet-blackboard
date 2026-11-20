import { useEffect, useState } from 'react';

/** useState that remembers its value in localStorage (only values listed in `allowed` are restored). */
export function usePersistedState<T extends string>(key: string, initial: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc. */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
