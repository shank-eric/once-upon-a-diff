/*
 * The board's top header, drawn by Preact (ADR-14): the title and the summary line, the usage meters, the repo filter and the
 * voice controls (Start, Pause or Resume and Stop voice, and the Phone menu). The filter's value is the page root's (remembered).
 */
import { html, useState } from '/assets/preact.mjs';
import { ROUTES } from '/assets/protocol/routes.ts';
import { openMenu } from '/assets/ui/menu.ts';
import type { BoardData, BoardLimit, BoardUsage } from '/assets/types.ts';
import { compactAge } from '/assets/protocol/domain/time.ts';
import { plural } from '/assets/protocol/domain/text.ts';
import { sameLaneKey } from '/assets/protocol/domain/lane-key.ts';
import { Meter } from '/assets/ui/meter.ts';
import type { Api } from '/assets/board/shared.ts';

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
 * What the voice buttons are waiting on, kept by the page root so that it outlives the header: a Larmor call that is out
 * (Start voice takes up to about 20 s, Stop voice about 3 s), or a phone-mode or bridge call (the row's buttons all wait
 * while Larmor works; turning phone mode on can take several seconds).
 */
export type VoiceCall = '' | 'start' | 'stop' | 'pause';
export function useVoiceBusy() {
  const [voiceCall, setVoiceCall] = useState<VoiceCall>('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  return { voiceCall, setVoiceCall, phoneBusy, setPhoneBusy };
}
export type VoiceBusy = ReturnType<typeof useVoiceBusy>;

/**
 * The voice controls in the board's top header, the rightmost items (past the repo dropdown):
 *  - voice off: Start voice in the last voice session, and a menu of the other sessions at their prompt (Larmor types
 *    /larmor into the tab, as its menu bar does; the last session busy leaves the others);
 *  - voice on: Pause (Resume while paused) and Stop voice;
 *  - a Phone menu (a dot while phone mode is on): turn phone mode on or off, and Stop phone bridge while the bridge runs.
 * Start and Stop need the Larmor checkout that can run voice_ctl; Pause and Resume only need its folder. Nothing when none applies.
 */
function VoiceControls(props: {
  voice: BoardData['voice'];
  phone: BoardData['phone'];
  voiceStart: BoardData['voice_start'];
  voicePaused: boolean;
  api: Api;
  busy: VoiceBusy;
}) {
  const { voice, phone, voiceStart, voicePaused, api } = props;
  const { voiceCall, setVoiceCall, phoneBusy, setPhoneBusy } = props.busy;
  const waiting = voiceCall !== '' || phoneBusy;
  const voiceOn = !!voice && voice.status !== 'ended';
  const voiceCallOf = async (kind: VoiceCall, what: string, call: () => Promise<unknown>) => {
    if (waiting) {
      return;
    }
    setVoiceCall(kind);
    try {
      await call();
    } catch (err) {
      alert(`Couldn't ${what}: ${(err as Error).message}`);
    }
    await api.refresh();
    setVoiceCall('');
  };
  const pause = (paused: boolean) =>
    voiceCallOf('pause', paused ? 'pause voice' : 'resume voice', () =>
      api.bridge.ask(ROUTES.boardVoicePause, { body: { paused } }),
    );
  const start = (session?: string) =>
    voiceCallOf('start', 'start voice', () =>
      api.bridge.ask(ROUTES.boardVoiceStart, { body: session ? { session } : {} }),
    );
  const stop = () => voiceCallOf('stop', 'stop voice', () => api.bridge.ask(ROUTES.boardVoiceStop));
  const phoneCall = async (action: 'on' | 'off' | 'bridge-stop') => {
    if (waiting) {
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
  const pickSession = (event: MouseEvent) => {
    const idle = (voiceStart?.candidates ?? []).filter((one) => one.idle);
    if (idle.length === 0) {
      alert("Couldn't start voice: no Claude Code session is waiting at its prompt");
      return;
    }
    openMenu(
      event.currentTarget as HTMLElement,
      idle.map((one) => ({
        value: one.id,
        label: one.name,
        checked: one.id === voiceStart?.last?.id,
      })),
      (id) => void start(id),
      { label: 'Start voice in' },
    );
  };
  const phoneMenu = (event: MouseEvent) => {
    if (!phone) {
      return;
    }
    openMenu(
      event.currentTarget as HTMLElement,
      [
        phone.on
          ? { value: 'off', label: 'Turn off phone mode', detail: 'Play lines on the Mac again' }
          : {
              value: 'on',
              label: 'Turn on phone mode',
              detail: "Send lines to your phone, free the Mac's mic",
            },
        ...(phone.bridge
          ? [
              {
                value: 'bridge-stop',
                label: 'Stop phone bridge',
                detail: 'Also turns phone mode off',
              },
            ]
          : []),
      ],
      (value) => void phoneCall(value as 'on' | 'off' | 'bridge-stop'),
      { label: 'Phone' },
    );
  };
  const last = voiceStart?.last
    ? voiceStart.candidates.find((one) => one.id === voiceStart.last?.id)
    : undefined;
  const starting = voiceCall === 'start';
  // a pause left by a session that died shows with voice off, and Resume is the way out (Start clears it too)
  const paused = voiceOn ? voice?.status === 'paused' : voicePaused;
  const lastTitle = last?.idle
    ? 'Type /larmor into that session, as the menu bar does'
    : `${voiceStart?.last?.name} is busy: pick another session`;
  const pauseTitle = paused
    ? 'Resume voice (removes ~/.larmor/paused, as the menu bar does)'
    : 'Pause voice: the mic is released and replies come as text';
  const phoneTitle = phone?.on ? 'Phone mode is on: lines go to your phone' : 'Phone mode is off';
  const buttons = [
    !voiceOn &&
      voiceStart &&
      (last && voiceStart.last
        ? html`<button type="button" data-voice-start="last" disabled=${waiting || !last.idle} onClick=${() => start(voiceStart.last?.id)} title=${lastTitle}>${starting ? 'Starting…' : `Start voice in ${voiceStart.last.name}`}</button>`
        : html`<button type="button" data-voice-start="pick" disabled=${waiting} onClick=${pickSession} aria-haspopup="menu" title="Choose a session to start voice in">${starting ? 'Starting…' : 'Start voice'} ▾</button>`),
    !voiceOn &&
      voiceStart &&
      last &&
      html`<button type="button" data-voice-start-menu disabled=${waiting} onClick=${pickSession} aria-haspopup="menu" aria-label="Start voice in another session">▾</button>`,
    (voiceOn || voicePaused) &&
      html`<button type="button" data-voice-pause=${paused ? 'resume' : 'pause'} disabled=${waiting} onClick=${() => pause(!paused)} title=${pauseTitle}>${paused ? 'Resume' : 'Pause'}</button>`,
    voiceOn &&
      voiceStart &&
      html`<button type="button" data-voice-stop disabled=${waiting} onClick=${stop} title="Stop voice, as the menu bar's Stop voice does">${voiceCall === 'stop' ? 'Stopping…' : 'Stop voice'}</button>`,
    phone &&
      html`<button type="button" data-voice-phone-menu=${phone.on ? 'on' : 'off'} disabled=${waiting} onClick=${phoneMenu} aria-haspopup="menu" title=${phoneTitle}>Phone${phone.on ? ' ●' : ''} ▾</button>`,
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
  /** The repo filter: a lane key, '' for All. The menu lists the lanes of the full board. */
  filter: string;
  /** The filter names a lane that is on the board (a lane that is gone shows everything). */
  filterOn: boolean;
  onFilter: (lane: string) => void;
  /** The tab view at any width (remembered by the page root); a narrow page has tabs whatever this says. */
  tabs: boolean;
  onToggleTabs: () => void;
  api: Api;
  busy: VoiceBusy;
};

export function Header(props: HeaderProps) {
  const { summary, data, now, filter, filterOn, onFilter, tabs, onToggleTabs, api, busy } = props;
  const chooseRepo = (event: MouseEvent) => {
    const lanes = api.board.lanes;
    openMenu(
      event.currentTarget as HTMLElement,
      [
        { value: '', label: 'All', detail: plural(lanes.length, 'lane'), checked: !filter },
        ...lanes.map((lane) => ({
          value: lane.key,
          label: lane.name,
          detail: plural(lane.cards.length, 'card'),
          checked: sameLaneKey(lane.key, filter),
        })),
      ],
      onFilter,
      { label: 'Show one repo' },
    );
  };
  return html`<header class="ou-local-top">
    <div class="ou-local-top-main"><h1>Agent board</h1><div class="ou-local-muted">${summary}</div></div>
    <${Usage} usage=${data.usage} now=${now} />
    <button type="button" data-board-filter aria-haspopup="menu" onClick=${chooseRepo} title="Narrow the whole board to one repo's lane">Repo: ${filterOn ? (api.board.lanes.find((lane) => sameLaneKey(lane.key, filter))?.name ?? filter) : 'All'} ▾</button>
    <button type="button" data-board-tabs aria-pressed=${String(tabs)} onClick=${onToggleTabs} title="Show This Mac and GitHub as two tabs at any width (a narrow window always does)">Tabs${tabs ? ' ●' : ''}</button>
    <${VoiceControls} voice=${data.voice} phone=${data.phone} voiceStart=${data.voice_start} voicePaused=${data.voice_paused} api=${api} busy=${busy} />
  </header>`;
}
