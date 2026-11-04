/*
 * When the panel draws. Its parts keep their own data (the viewed marks, the change tags, the working marks, the count note's
 * numbers) and say `update()` when it changes; the view draws the whole panel from them at once, so the DOM is current as soon
 * as `update()` returns, which callers that read the panel's DOM right after a step change rely on.
 *
 * A draw that is asked for while one is running (a part that says `update()` from something the draw runs) is not nested, because
 * Preact does not support a render inside a render: it is noted, and the draw runs once more when the first is done. A part that
 * keeps asking is stopped after MAX_ROUNDS, so a loop shows as a stale panel, not a frozen page. No Preact here, so Node tests use it.
 */
const MAX_ROUNDS = 10;

export function createView(draw: () => void) {
  let drawing = false;
  let again = false;
  /** Draws now, or once the draw that is running is done. */
  function update(): void {
    if (drawing) {
      again = true;
      return;
    }
    drawing = true;
    try {
      let rounds = 0;
      do {
        again = false;
        draw();
      } while (again && ++rounds < MAX_ROUNDS);
    } finally {
      drawing = false;
      again = false;
    }
  }
  return { update };
}

export type View = ReturnType<typeof createView>;
