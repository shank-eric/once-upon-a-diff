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
