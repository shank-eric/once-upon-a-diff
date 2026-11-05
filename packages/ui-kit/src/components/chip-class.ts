/*
 * The class text of a chip, as a pure function (no Preact), so the Chip component and a piece of string markup (the panel's file status
 * pill, which sits in the story's text) draw the same one. The look is ui.css's (`ou-ui-chip`, `ou-ui-chip-<size>`, `ou-ui-tone-<tone>`,
 * `ou-ui-tint-<tone>`, `ou-ui-chip-strong`).
 */

/** The colour of a chip: its text and its border. `inherit` takes the text colour from the host's own class. No tone is the neutral chip. */
export type ChipTone = 'muted' | 'accent' | 'success' | 'attention' | 'inherit';
export type ChipSize = 'sm' | 'md' | 'lg';

export interface ChipLook {
  tone?: ChipTone;
  /** a background in the tone's tint (attention and accent have one) */
  tint?: boolean;
  /** weight 600 */
  strong?: boolean;
  /** padding 0 5px, 0 6px (the default) or 0 7px */
  size?: ChipSize;
  /** the host's own classes, added last */
  class?: string;
}

const TINTED: Partial<Record<ChipTone, true>> = { attention: true, accent: true };

/** `ou-ui-chip` and the classes the look asks for, then the host's own. */
export function chipClass(look: ChipLook = {}): string {
  const { tone, tint, strong, size, class: extra } = look;
  const classes = ['ou-ui-chip'];
  if (size && size !== 'md') {
    classes.push(`ou-ui-chip-${size}`);
  }
  if (tone) {
    classes.push(`ou-ui-tone-${tone}`);
  }
  if (tint && tone && TINTED[tone]) {
    classes.push(`ou-ui-tint-${tone}`);
  }
  if (strong) {
    classes.push('ou-ui-chip-strong');
  }
  if (extra) {
    classes.push(extra);
  }
  return classes.join(' ');
}
