/*
 * What the panel does with markup its parts built as a string (the story's text, an answer): turns it into nodes
 * (parse-markup.ts) and gives the elements in it the panel's own behavior. A Mark viewed pill becomes the live button, and
 * an element that carries data-rel (a file or line link) jumps to it when clicked.
 */
import { parseMarkup, type VNode } from '@once-upon-a-diff/ui-kit/parse-markup';
import type { PanelContext } from '../host/context.ts';
import type { Side } from '@once-upon-a-diff/domain/line-refs';

export function createMarkup(context: PanelContext) {
  /** The nodes for a piece of markup, in order. */
  function nodes(markupText: unknown): (VNode | string)[] {
    return parseMarkup(markupText, {
      element(tag, props) {
        if (tag === 'button' && props['data-mark-for']) {
          // a Mark viewed pill beside a file's mention
          return context.viewed.markButton(
            String(props['data-mark-for']),
            props['data-mark-short'] !== undefined,
          );
        }
        if (props['data-rel'] !== undefined) {
          const rel = String(props['data-rel']);
          const line =
            props['data-start'] !== undefined
              ? {
                  side: String(props['data-side'] || 'R') as Side,
                  start: +String(props['data-start']),
                  end: +String(props['data-end']) || +String(props['data-start']),
                }
              : null;
          props.onClick = context.refs.jumpClick(rel, line);
        }
      },
    });
  }

  return { nodes };
}

export type Markup = ReturnType<typeof createMarkup>;
