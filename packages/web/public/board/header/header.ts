/*
 * The board's top header, drawn by Preact (ADR-14): the title and the summary line, the usage meters, the repo filter and the
 * voice controls (Resume, the phone-mode toggle, Stop phone bridge). The filter's value is the page root's (remembered).
 */
import { html, useState } from '/assets/preact.mjs';
import { ROUTES } from '/assets/protocol/routes.ts';
import { openMenu } from '/assets/local/menu.ts';
import type { BoardData, BoardLimit, BoardUsage } from '/assets/types.ts';
import { compactAge } from '/assets/util/time.ts';
import { plural } from '/assets/util/text.ts';
import { Meter, type Api } from '/assets/board/shared.ts';

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
function Usage(props: { usage: BoardUsage | null; now: number }) {
  const { usage, now } = props;
  if (!usage) {
    return null;
  }
  const seen = compactAge(usage.at, now);
  const limit = (label: string, name: string, value: BoardLimit | null) => {
    if (!value) {
      return null;
    }
    const resets = resetText(value.resets_at, now);
    const title = `${name}: ${Math.round(value.percent)}% used${resets ? `, resets ${resets}` : ''}${seen ? ` (status line read ${seen} ago)` : ''}`;
    return html`<${Meter} label=${label} percent=${value.percent} title=${title}>${value.percent >= 70 && resets && html`<span class="ou-board-meter-reset">resets ${resets}</span>`}</${Meter}>`;
  };
  const five = limit('5h', '5-hour limit', usage.five_hour);
  const week = limit('week', 'Weekly limit', usage.seven_day);
  return five || week
    ? html`<div class="ou-board-meters" aria-label="Usage">${five}${week}</div>`
    : null;
}

/**
 * What the voice buttons are waiting on, kept by the page root so that it outlives the header: a resume is out, or a phone-mode
 * or bridge call is running (the row's buttons all wait while Larmor works; turning on can take several seconds).
 */
export function useVoiceBusy() {
  const [resuming, setResuming] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  return { resuming, setResuming, phoneBusy, setPhoneBusy };
}
export type VoiceBusy = ReturnType<typeof useVoiceBusy>;

/**
 * The voice controls in the board's top header, the rightmost items (past the repo dropdown): Resume while voice is paused,
 * the phone-mode toggle whenever the Larmor checkout can run it, voice on or not (Larmor's away mode, which starts the phone
 * bridge), and Stop phone bridge while the bridge runs. Nothing when none applies.
 */
function VoiceControls(props: {
  voice: BoardData['voice'];
  phone: BoardData['phone'];
  api: Api;
  busy: VoiceBusy;
}) {
  const { voice, phone, api } = props;
  const { resuming, setResuming, phoneBusy, setPhoneBusy } = props.busy;
  const resume = async () => {
    setResuming(true);
    try {
      await api.bridge.ask(ROUTES.boardVoicePause, { body: { paused: false } });
    } catch (err) {
      alert(`Couldn't resume voice: ${(err as Error).message}`);
    }
    await api.refresh();
    setResuming(false);
  };
  const phoneCall = async (action: 'on' | 'off' | 'bridge-stop') => {
    if (phoneBusy) {
      return;
    }
    setPhoneBusy(true);
    try {
      if (action === 'bridge-stop') {
        await api.bridge.ask(ROUTES.boardVoiceBridgeStop);
      } else {
        await api.bridge.ask(ROUTES.boardVoicePhone, { body: { on: action === 'on' } });
      }
    } catch (err) {
      alert(
        `Couldn't ${action === 'bridge-stop' ? 'stop the phone bridge' : `turn phone mode ${action}`}: ${(err as Error).message}`,
      );
    } finally {
      setPhoneBusy(false);
    }
    await api.refresh();
  };
  const phoneModeTitle = phone?.on
    ? 'Phone mode is on: lines go to your phone. Turn it off to play them on the Mac again'
    : "Send voice lines to your phone and release the Mac's mic (starts the phone bridge)";
  const buttons = [
    voice?.status === 'paused' &&
      html`<button type="button" data-voice-pause="resume" disabled=${resuming || phoneBusy} onClick=${resume} title="Resume voice (removes ~/.larmor/paused, as the menu bar does)">Resume</button>`,
    phone &&
      html`<button type="button" disabled=${phoneBusy} data-voice-phone=${phone.on ? 'off' : 'on'} onClick=${() => phoneCall(phone.on ? 'off' : 'on')} title=${phoneModeTitle}>${phone.on ? 'Turn off phone mode' : 'Turn on phone mode'}</button>`,
    phone &&
      phone.bridge &&
      html`<button type="button" disabled=${phoneBusy} data-voice-phone="bridge-stop" onClick=${() => phoneCall('bridge-stop')} title="Stop the phone bridge (also turns phone mode off)">Stop phone bridge</button>`,
  ].filter(Boolean);
  return buttons.length > 0
    ? html`<div class="ou-local-top-voice ou-board-voice-phone" role="group" aria-label="Voice controls">${buttons}</div>`
    : null;
}

export type HeaderProps = {
  /** The summary line under the title. */
  summary: string;
  data: BoardData;
  now: number;
  /** The repo filter: a lane name, '' for All. The menu lists the lanes of the full board. */
  filter: string;
  /** The filter names a lane that is on the board (a lane that is gone shows everything). */
  filterOn: boolean;
  onFilter: (lane: string) => void;
  api: Api;
  busy: VoiceBusy;
};

export function Header(props: HeaderProps) {
  const { summary, data, now, filter, filterOn, onFilter, api, busy } = props;
  const chooseRepo = (event: MouseEvent) => {
    const lanes = api.board.lanes;
    openMenu(
      event.currentTarget as HTMLElement,
      [
        { value: '', label: 'All', detail: plural(lanes.length, 'lane'), checked: !filter },
        ...lanes.map((lane) => ({
          value: lane.name,
          label: lane.name,
          detail: plural(lane.cards.length, 'card'),
          checked: lane.name === filter,
        })),
      ],
      onFilter,
      { label: 'Show one repo' },
    );
  };
  return html`<header class="ou-local-top">
    <div class="ou-local-top-main"><h1>Agent board</h1><div class="ou-local-muted">${summary}</div></div>
    <${Usage} usage=${data.usage} now=${now} />
    <button type="button" data-board-filter aria-haspopup="menu" onClick=${chooseRepo} title="Narrow the whole board to one repo's lane">Repo: ${filterOn ? filter : 'All'} ▾</button>
    <${VoiceControls} voice=${data.voice} phone=${data.phone} api=${api} busy=${busy} />
  </header>`;
}
