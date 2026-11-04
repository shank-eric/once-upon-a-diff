/*
 * What the panel does with markup its parts built as a string (the story's text, an answer, a drafted comment): turns it into nodes
 * (parse-markup.ts) and gives the elements in it the panel's own behavior. A Mark viewed pill becomes the live button, and the
 * list of every drafted comment remembers whether it is open. With `jumps`, an element that carries data-rel (a file or line
 * link) jumps to it when clicked: the body leaves that to its delegated click handler until the parts that write into it are
 * converted, so asking for it there would jump twice.
 */
import { parseMarkup, type VNode } from './parse-markup.ts';
import type { PanelContext } from './context.ts';
import type { Side } from '@once-upon-a-diff/protocol/types';

export interface NodesOptions {
  /** Draw a click on a data-rel element as a jump to it. */
  jumps?: boolean;
}

export function createMarkup(context: PanelContext) {
  const { state } = context;

  /** The nodes for a piece of markup, in order. */
  function nodes(markupText: unknown, options: NodesOptions = {}): (VNode | string)[] {
    return parseMarkup(markupText, {
      element(tag, props) {
        if (tag === 'button' && props['data-mark-for']) {
          // a Mark viewed pill beside a file's mention
          return context.viewed.markButton(
            String(props['data-mark-for']),
            props['data-mark-short'] !== undefined,
          );
        }
        if (tag === 'details' && String(props.class).includes('ou-allc')) {
          props.onToggle = (event: Event) => {
            state.allCommentsOpen = (event.currentTarget as HTMLDetailsElement).open;
          };
        }
        if (options.jumps && props['data-rel'] !== undefined) {
          const rel = String(props['data-rel']);
          const line =
            props['data-start'] !== undefined
              ? {
                  side: String(props['data-side'] || 'R') as Side,
                  start: +String(props['data-start']),
                  end: +String(props['data-end']) || +String(props['data-start']),
                }
              : null;
          props.onClick = () => context.scroll.jumpTo(rel, line);
        }
      },
    });
  }

  return { nodes };
}

export type Markup = ReturnType<typeof createMarkup>;
