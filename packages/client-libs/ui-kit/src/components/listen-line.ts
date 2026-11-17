/*
 * The line to run by hand when Start listening has no session to type into: the line, a Copy button and, when the host can queue it
 * for the next session, a Queue button (busy until the host answers). The panel and the extension's notice share it.
 */
import { html } from '/assets/preact.mjs';
import { ActionButton } from './action-button.ts';
import { CopyButton } from './copy-button.ts';

export function ListenLine(props: { line: string; onQueue?: () => Promise<unknown> }) {
  const { line, onQueue } = props;
  return html`<span class="ou-startline"><code>${line}</code> <${CopyButton} text=${line} title="Copy this line" onFailed=${() => 'Select and copy it'}>Copy</${CopyButton}>${
    onQueue &&
    html` <${ActionButton} title="The next message you send in a Claude Code session in that checkout starts it (needs once-upon install-hooks)" onClick=${onQueue}>Queue for my next message</${ActionButton}>`
  }</span>`;
}
