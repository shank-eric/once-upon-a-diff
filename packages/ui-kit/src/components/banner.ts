/*
 * Banner: a short note set off from the text around it by a rule down its left edge and a tint, in a tone (accent for news, warn
 * for something under way). Styled by ui.css (`ou-ui-banner`, `ou-ui-banner-<tone>`). `class` adds the host's own (its margins,
 * the hook its tests find it by); other props (`role`...) go to the element.
 */
import { html } from '/assets/preact.mjs';

export type BannerTone = 'accent' | 'warn';

export function Banner({
  tone,
  class: extra,
  children,
  ...rest
}: {
  tone: BannerTone;
  class?: string;
  children?: unknown;
  [prop: string]: unknown;
}) {
  const classes = `ou-ui-banner ou-ui-banner-${tone}`;
  return html`<div class=${extra ? `${classes} ${extra}` : classes} ...${rest}>${children}</div>`;
}
