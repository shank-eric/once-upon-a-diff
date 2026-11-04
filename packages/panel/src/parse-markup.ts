/*
 * Turns markup our own code built as a string (the story's markdown, the drafted comments, the "Since you read it" banner)
 * into Preact nodes, so a draw puts it in the tree like any other element, with no wrapper element around it. The markup is
 * escaped where it was built (markdown.ts, the html`` tag in protocol/domain/html.ts), so this reads it as the browser would and
 * never runs it. A part that still writes into what it drew (the drafts' state lines) finds its elements where they were.
 *
 * `element` is asked about each element on the way: it may change the props it will get (an onToggle on a list) or answer with
 * a node of its own to put there (the Mark viewed button, which is a component).
 */
import { h } from '/assets/preact.mjs';
import type { html } from '/assets/preact.mjs';

/** What `h` and the html`` tag make: a node for Preact to draw. */
export type VNode = ReturnType<typeof html>;

/** Attributes that are true by being there: Preact sets these as properties, where "" would read as false. */
const BOOLEAN = new Set([
  'hidden',
  'open',
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
]);

type Props = Record<string, unknown>;
export interface MarkupHooks {
  element?(tag: string, props: Props): VNode | void;
}

function convert(node: Node, hooks: MarkupHooks): (VNode | string)[] {
  if (node.nodeType === 3) {
    return [node.textContent || ''];
  }
  if (node.nodeType !== 1) {
    return [];
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const props: Props = {};
  for (const attr of el.attributes) {
    props[attr.name] = BOOLEAN.has(attr.name) ? true : attr.value;
  }
  const replaced = hooks.element?.(tag, props);
  if (replaced) {
    return [replaced];
  }
  return [h(tag, props, ...[...el.childNodes].flatMap((child) => convert(child, hooks))) as VNode];
}

/** The nodes for a piece of markup, in order. */
export function parseMarkup(markup: unknown, hooks: MarkupHooks = {}): (VNode | string)[] {
  const text = String(markup ?? '');
  if (!text) {
    return [];
  }
  const holder = document.createElement('template');
  holder.innerHTML = text;
  const content = (holder as HTMLTemplateElement).content ?? holder;
  return [...content.childNodes].flatMap((child) => convert(child, hooks));
}
