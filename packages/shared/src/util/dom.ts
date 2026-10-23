// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Small DOM helpers shared by the panel, the local page and the content
 * scripts' own elements: key isolation, stylesheets and setting markup.
 */
import { html } from './html.ts';

/** Keeps key events inside our element, so the host page's single-key shortcuts don't fire while typing in it. */
export function stopKeyEvents(target) {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.addEventListener(type, (event) => event.stopPropagation());
  }
}

/** How long an element waits, hidden, for its stylesheets before it shows anyway. */
const STYLESHEET_WAIT_MS = 1500;

/** A <link rel="stylesheet"> for href, to put in a shadow root or the document's head. */
export function stylesheetLink(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  return link;
}

/**
 * Keeps element hidden until each link has loaded (or failed, or STYLESHEET_WAIT_MS went by), so it never shows
 * unstyled. Call it before the links go on the page: a link starts loading when it's connected.
 */
export function hideUntilStyled(element, links) {
  element.style.visibility = 'hidden';
  const loads = links.map(
    (link) =>
      new Promise((resolve) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
      }),
  );
  const waited = new Promise((resolve) => setTimeout(resolve, STYLESHEET_WAIT_MS));
  Promise.race([Promise.all(loads), waited]).then(() => element.style.removeProperty('visibility'));
}

/** Puts markup in element in place of its children: html`` markup as is, anything else (a plain string) as text. */
export function setHtml(element, markup) {
  element.innerHTML = html`${markup}`.markup;
}

/** Inserts markup at position ('beforeend', 'afterend'...) the way setHtml does. */
export function insertHtml(element, position, markup) {
  element.insertAdjacentHTML(position, html`${markup}`.markup);
}
