/*
 * What the board remembers lives in localStorage, which can be missing or blocked. `stored` is the saved text under a key
 * (run through `parse` when there is one), or `fallback` when none is saved, it does not parse or storage throws. `remember`
 * saves one, and a choice that cannot be saved just isn't remembered.
 */

export function stored<T>(key: string, fallback: T, parse?: (text: string) => T): T {
  try {
    const text = localStorage.getItem(key);
    if (text === null) {
      return fallback;
    }
    return parse ? parse(text) : (text as T);
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice just isn't remembered */
  }
}
