/*
 * The confirm box the page has open, if any: Create pull request, drawn in the page's tree from the
 * store (ship.dialog), one at a time. Opening another box takes this one away, and the box closing (Cancel, Close, Escape, a
 * click on the backdrop) says so to the store.
 */
import { html } from '/assets/preact.mjs';
import { closeDialog } from '/assets/local/actions.ts';
import { ActionDialog } from './action-dialog.ts';
import { prSpec } from './pull-request.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { DialogName } from '/assets/local/store.ts';

export function DialogHost(props: { story: LocalStoryData; dialog: DialogName | null }) {
  const { story, dialog } = props;
  if (!dialog) {
    return null;
  }
  return html`<${ActionDialog} key=${dialog} spec=${prSpec(story) as never} onClose=${closeDialog} />`;
}
