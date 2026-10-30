import type { BoardData, BoardLimit, BoardUsage, BoardVoice } from '/assets/types.ts';
import { compactAge } from '/assets/util/time.ts';
import { html } from '/assets/util/html.ts';
import { meterHtml } from '/assets/board/shared.ts';

/** When a limit resets: the time today, else the weekday and hour. */
function resetText(iso: string | null, now: number): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString(
    [],
    sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric' },
  );
}

/**
 * The usage meters in the header's right side: the 5-hour and weekly limits as thin bars. The reset time and how old the
 * status line's reading is go in the tooltip, and the reset shows beside the bar once a limit is at 70%.
 */
export function usageHtml(usage: BoardUsage | null, now: number) {
  if (!usage) {
    return '';
  }
  const seen = compactAge(usage.at, now);
  const limit = (label: string, name: string, value: BoardLimit | null) => {
    if (!value) {
      return '';
    }
    const resets = resetText(value.resets_at, now);
    const title = `${name}: ${Math.round(value.percent)}% used${resets ? `, resets ${resets}` : ''}${seen ? ` (status line read ${seen} ago)` : ''}`;
    const note =
      value.percent >= 70 && resets
        ? html`<span class="ou-board-meter-reset">resets ${resets}</span>`
        : '';
    return meterHtml(label, value.percent, title, note);
  };
  const five = limit('5h', '5-hour limit', usage.five_hour);
  const week = limit('week', 'Weekly limit', usage.seven_day);
  return five || week
    ? html`<div class="ou-board-meters" aria-label="Usage">${five}${week}</div>`
    : '';
}

/**
 * The voice controls in the board's top header, the rightmost items (past the repo dropdown): Resume while voice is paused,
 * the phone-mode toggle whenever the Larmor checkout can run it, voice on or not (Larmor's away mode, which starts the phone
 * bridge), and Stop phone bridge while the bridge runs. Nothing when none applies.
 */
export function voiceHeaderHtml(
  voice: BoardVoice | null,
  phone: BoardData['phone'],
  phoneBusy: boolean,
) {
  const phoneModeTitle = phone?.on
    ? 'Phone mode is on: lines go to your phone. Turn it off to play them on the Mac again'
    : "Send voice lines to your phone and release the Mac's mic (starts the phone bridge)";
  const buttons = [
    voice?.status === 'paused' &&
      html`<button type="button" data-voice-pause="resume" title="Resume voice (removes ~/.larmor/paused, as the menu bar does)">Resume</button>`,
    phone &&
      html`<button type="button"${phoneBusy && html` disabled`} data-voice-phone="${phone.on ? 'off' : 'on'}" title="${phoneModeTitle}">${phone.on ? 'Turn off phone mode' : 'Turn on phone mode'}</button>`,
    phone &&
      phone.bridge &&
      html`<button type="button"${phoneBusy && html` disabled`} data-voice-phone="bridge-stop" title="Stop the phone bridge (also turns phone mode off)">Stop phone bridge</button>`,
  ].filter(Boolean);
  return buttons.length > 0
    ? html`<div class="ou-local-top-voice ou-board-voice-phone" role="group" aria-label="Voice controls">${buttons}</div>`
    : '';
}
