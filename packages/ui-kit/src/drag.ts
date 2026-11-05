/*
 * createDrag: a pointer drag on a thin handle (a resize grip). Its `handlers` go on the handle's element (spread onto a Preact
 * vnode); the pointer is captured, so the drag goes on when it leaves the handle. A drag ends on pointer up, on pointer cancel, when
 * capture is lost, and on a move that says no button is down (the release happened where no event reached us); `onEnd` runs once.
 * Nothing is drawn: the caller's `onMove` says what the pointer's place means (a width, a height).
 */
export interface DragOptions {
  /** Runs on a press, before the drag starts. Answer false to refuse it (a handle that is not live). */
  onStart?: (event: PointerEvent) => boolean | void;
  /** The pointer moved during the drag. */
  onMove: (event: PointerEvent) => void;
  /** The drag is over, however it ended. */
  onEnd: () => void;
  /** Only the primary button starts a drag. */
  primary?: boolean;
}

export function createDrag(options: DragOptions) {
  const { onStart, onMove, onEnd, primary = false } = options;
  let active = false;
  const end = () => {
    if (active) {
      active = false;
      onEnd();
    }
  };
  const handlers = {
    onPointerDown(event: PointerEvent) {
      if (primary && event.button !== 0) {
        return;
      }
      if (onStart?.(event) === false) {
        return;
      }
      event.preventDefault();
      // on before the capture, so a capture that throws still ends through onEnd (the caller's onStart may have marked the page)
      active = true;
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch (err) {
        end();
        throw err;
      }
    },
    onPointerMove(event: PointerEvent) {
      if (!active) {
        return;
      }
      // the button came up where no pointerup reached us: the drag is over
      if (event.buttons === 0) {
        end();
        return;
      }
      onMove(event);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
  return { handlers, active: () => active, end };
}
