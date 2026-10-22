/*
 * Small DOM helpers shared by the panel and the content scripts' own
 * elements.
 */

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
