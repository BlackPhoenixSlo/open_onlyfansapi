// localStorage as JSON, best effort: a missing, unreadable or malformed value reads as null, and a failed write
// (storage full or disabled) is ignored.

/** The stored value, or null when it is missing, unreadable or not of the expected shape. */
export function readStored<T>(key: string, is: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return is(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores `value` as JSON; null removes the key. */
export function writeStored(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: remembering is best effort.
  }
}
