/*
 * The state a panel starts from (panel-state.ts, layout.ts and the host context all use it). Types only.
 */
import type { PanelUi } from '@once-upon-a-diff/contracts/types';

/** A saved state to start from, plus the body's scroll on a live redraw. */
export type InitialUi = Partial<PanelUi> & { bodyScroll?: number; hidden?: boolean };
