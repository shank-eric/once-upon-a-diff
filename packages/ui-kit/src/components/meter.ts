/*
 * A usage meter: a label, a thin bar filled to a percentage and the number, yellow from 70% and red from 90% like the status
 * line. Styled by ui.css (`ou-ui-meter*`).
 */
import { html } from '/assets/preact.mjs';

/** The warning class for a percentage: yellow from 70, red from 90. */
function levelOf(value: number) {
  if (value >= 90) {
    return ' ou-ui-usage-high';
  }
  return value >= 70 ? ' ou-ui-usage-warn' : '';
}

/** A label, a thin bar filled to a percentage and the number, yellow from 70% and red from 90% like the status line. */
export function Meter(props: {
  label: string;
  percent: number;
  title: string;
  children?: unknown;
}) {
  const { label, percent, title, children } = props;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return html`<span class=${`ou-ui-meter${levelOf(percent)}`} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${clamped} aria-label=${label} title=${title}>
    <span class="ou-ui-meter-label">${label}</span>
    <span class="ou-ui-meter-bar" aria-hidden="true"><span style=${`width:${clamped}%`}></span></span>
    <span class="ou-ui-meter-num">${clamped}%</span>${children}
  </span>`;
}

/** A session's context meter, or nothing when its context is not known. */
export function ContextMeter(props: { context: number | null | undefined }) {
  const { context } = props;
  return typeof context === 'number'
    ? html` <${Meter} label="ctx" percent=${context} title=${`The session's context window is ${Math.round(context)}% full`} />`
    : null;
}
