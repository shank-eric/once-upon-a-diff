/*
 * Small DOM helpers shared by the panel, the local page and the content
 * scripts' own elements: key isolation, stylesheets and setting markup.
 */
import { html, type HtmlValue } from '@once-upon-a-diff/domain/html';

/** Keeps key events inside our element, so the host page's single-key shortcuts don't fire while typing in it. */
export function stopKeyEvents(target: EventTarget): void {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.addEventListener(type, (event) => event.stopPropagation());
  }
}

/** How long an element waits, hidden, for its stylesheets before it shows anyway. */
const STYLESHEET_WAIT_MS = 1500;

/** A <link rel="stylesheet"> for href, to put in a shadow root or the document's head. */
export function stylesheetLink(href: string): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  return link;
}

/**
 * Keeps element hidden until each link has loaded (or failed, or STYLESHEET_WAIT_MS went by), so it never shows
 * unstyled. Call it before the links go on the page: a link starts loading when it's connected.
 */
export function hideUntilStyled(element: HTMLElement, links: HTMLLinkElement[]): void {
  element.style.visibility = 'hidden';
  const loads = links.map(
    (link) =>
      new Promise<unknown>((resolve) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
      }),
  );
  const waited = new Promise((resolve) => setTimeout(resolve, STYLESHEET_WAIT_MS));
  Promise.race([Promise.all(loads), waited]).then(() => element.style.removeProperty('visibility'));
}

/**
 * Our own element in a shadow root of its own, on a page we do not control (GitHub's): the host's open shadow root gets a link for
 * each stylesheet and then the root element the caller draws into, and the host stays hidden until the stylesheets are in. The host is
 * made by the caller (a div with an id, a span with an attribute). `isolateKeys` keeps key events inside the root element or the
 * shadow root; `into` puts the host on the page now (without it the caller places it).
 */
export function mountShadow(options: {
  host: HTMLElement;
  stylesheets: string[];
  className: string;
  tag?: string;
  role?: string;
  isolateKeys?: 'root' | 'shadow';
  into?: Element;
}): { host: HTMLElement; shadow: ShadowRoot; root: HTMLElement; links: HTMLLinkElement[] } {
  const { host, stylesheets, className, tag = 'div', role, isolateKeys, into } = options;
  const shadow = host.attachShadow({ mode: 'open' });
  const links = stylesheets.map(stylesheetLink);
  const root = document.createElement(tag);
  root.className = className;
  if (role) {
    root.setAttribute('role', role);
  }
  shadow.append(...links, root);
  hideUntilStyled(host, links);
  if (isolateKeys) {
    stopKeyEvents(isolateKeys === 'root' ? root : shadow);
  }
  into?.appendChild(host);
  return { host, shadow, root, links };
}

/** Puts markup in element in place of its children: html`` markup as is, anything else (a plain string) as text. */
export function setHtml(element: Element, markup: HtmlValue): void {
  element.innerHTML = html`${markup}`.markup;
}

/** Inserts markup at position ('beforeend', 'afterend'...) the way setHtml does. */
export function insertHtml(element: Element, position: InsertPosition, markup: HtmlValue): void {
  element.insertAdjacentHTML(position, html`${markup}`.markup);
}
