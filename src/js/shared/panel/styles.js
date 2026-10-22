/*
 * The panel's CSS. Primer variables, so GitHub's light and dark themes carry
 * over (the local page defines the same variables).
 */

/**
 * The few rules the host page gets, all keyed to the panel's own id, class and data-prs-* attributes:
 * docking (the page's right margin), hiding other chapters' files and flashing a jump's target.
 */
export const documentCss = (hostId) => `
  html.${hostId}-docked body { margin-right: var(--prs-w) !important; }
  #${hostId} { all: initial; }
  [data-prs-hidden] { display: none !important; }
  [data-prs-flash] { outline: 2px solid var(--fgColor-accent, #0969da) !important; outline-offset: 2px; border-radius: 6px; }
  tr[data-prs-flash] { outline: none !important; }
  tr[data-prs-flash] > td { background-color: var(--bgColor-attention-muted, #fff8c5) !important; box-shadow: inset 0 0 0 9999px rgba(212,167,44,.12); }
  `;

/** Everything else, inside the panel's shadow root, so the page's CSS (and other extensions') can't reach it, nor it them. */
export const panelCss = (panelId) => `
  :host { all: initial; }
  #${panelId}:focus { outline: none; }
  #${panelId} { --c-bg: var(--bgColor-default, #fff); --c-fg: var(--fgColor-default, #1f2328); --c-muted: var(--fgColor-muted, #59636e);
    --c-border: var(--borderColor-default, #d1d9e0); --c-subtle: var(--bgColor-muted, #f6f8fa); --c-accent: var(--fgColor-accent, #0969da);
    --c-accent-bg: var(--bgColor-accent-muted, #ddf4ff); --c-ok: var(--fgColor-success, #1a7f37); --c-warn: var(--fgColor-attention, #9a6700); --c-err: var(--fgColor-danger, #d1242f);
    position: fixed; top: 0; right: 0; bottom: 0; width: var(--prs-w); z-index: 99; box-sizing: border-box;
    background: var(--c-bg); color: var(--c-fg); border-left: 1px solid var(--c-border);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; box-shadow: -4px 0 12px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { #${panelId} { --c-bg: var(--bgColor-default, #0d1117); --c-fg: var(--fgColor-default, #f0f6fc);
    --c-muted: var(--fgColor-muted, #9198a1); --c-border: var(--borderColor-default, #3d444d); --c-subtle: var(--bgColor-muted, #151b23);
    --c-accent: var(--fgColor-accent, #4493f8); --c-accent-bg: var(--bgColor-accent-muted, #388bfd1a);
    --c-ok: var(--fgColor-success, #3fb950); --c-warn: var(--fgColor-attention, #d29922); --c-err: var(--fgColor-danger, #f85149); } }
  #${panelId} * { box-sizing: border-box; }
  #${panelId} .prs-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; }
  #${panelId} .prs-grip:hover, #${panelId}.prs-dragging .prs-grip { background: var(--c-accent); opacity: .35; }
  #${panelId} .prs-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--c-border); background: var(--c-subtle); }
  #${panelId} .prs-bar .prs-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${panelId} button { font: inherit; font-size: 12px; color: var(--c-fg); background: var(--c-bg); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #${panelId} button:hover:not(:disabled) { border-color: var(--c-accent); }
  #${panelId} button:disabled { opacity: .45; cursor: default; }
  #${panelId} button[aria-pressed="true"] { background: var(--c-accent-bg); border-color: var(--c-accent); }
  #${panelId} .prs-note { padding: 6px 12px; font-size: 12px; color: var(--c-muted); border-bottom: 1px solid var(--c-border);
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #${panelId} .prs-note b { color: var(--c-fg); }
  #${panelId} .prs-msg { flex-basis: 100%; color: var(--c-warn); }
  #${panelId} button.prs-light { border: 0; background: none; padding: 2px 4px; }
  #${panelId} .prs-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--c-muted); vertical-align: middle; }
  #${panelId} .prs-light[data-level="ok"] .prs-dot { background: var(--c-ok); }
  #${panelId} .prs-light[data-level="warn"] .prs-dot { background: var(--c-warn); }
  #${panelId} .prs-light[data-level="error"] .prs-dot { background: var(--c-err); }
  #${panelId} .prs-health { flex-basis: 100%; margin: 2px 0; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-bg); }
  #${panelId} .prs-health ul { list-style: none; margin: 0; padding: 0; }
  #${panelId} .prs-health li { padding: 1px 0; }
  #${panelId} .prs-health .prs-hok { color: var(--c-ok); } #${panelId} .prs-health .prs-hwarn { color: var(--c-warn); } #${panelId} .prs-health .prs-herr { color: var(--c-err); }
  #${panelId} .prs-fresh { flex-basis: 100%; font-size: 12px; }
  #${panelId} .prs-fresh:empty { display: none; }
  #${panelId} .prs-fresh.prs-stale { color: var(--c-warn); }
  #${panelId} .prs-fresh button { margin-left: 6px; }
  #${panelId} .prs-chg { font-size: 11px; color: var(--c-warn); margin-left: 4px; white-space: nowrap; }
  #${panelId} .prs-cstate .prs-cstale { color: var(--c-warn); }
  #${panelId} .prs-new { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--c-accent); border: 1px solid currentColor; border-radius: 9px; padding: 0 5px; }
  #${panelId} .prs-since { margin: 10px 0; padding: 6px 10px; border-left: 3px solid var(--c-accent); background: var(--c-accent-bg); border-radius: 0 6px 6px 0; font-size: 12px; }
  #${panelId} .prs-askhint { padding: 6px 10px 0; font-size: 12px; color: var(--c-warn); background: var(--c-subtle); border-top: 1px solid var(--c-border); }
  #${panelId} .prs-askhint code { font-size: 11px; }
  #${panelId} .prs-askhint .prs-copyprompt { margin-left: 4px; }
  #${panelId} .prs-askhint .prs-promptmore { border: 0; background: none; padding: 0 2px; color: var(--c-accent, inherit); text-decoration: underline; cursor: pointer; font-size: 11px; }
  #${panelId} .prs-askhint .prs-promptlong, #${panelId} .prs-askhint .prs-prompt { white-space: pre-wrap; word-break: break-all; font-size: 11px; margin: 4px 0 0; color: var(--c-fg); }
  #${panelId} .prs-progress { margin: 0 0 10px; padding: 4px 8px; font-size: 12px; color: var(--c-muted); border-left: 3px solid var(--c-border); }
  #${panelId} .prs-progress:empty { display: none; }
  #${panelId} .prs-progress.prs-complete { border-left-color: var(--c-ok); }
  #${panelId} .prs-early-box { margin: 0 0 10px; padding: 6px 8px; font-size: 12px; border: 1px solid var(--c-warn); border-radius: 6px; }
  #${panelId} .prs-early-box:empty { display: none; }
  #${panelId} .prs-early-box p { margin: 0 0 3px; }
  #${panelId} .prs-viewed.prs-early { color: var(--c-warn); }
  #${panelId} .prs-progress .prs-done { color: var(--c-ok); font-weight: 600; }
  #${panelId} .prs-progress b { color: var(--c-fg); }
  #${panelId} .prs-stepprog { font-size: 11px; color: var(--c-muted); margin-left: 4px; }
  #${panelId} .prs-stepprog.prs-done { color: var(--c-ok); }
  #${panelId} details.prs-filesbox > summary, #${panelId} details.prs-allc > summary { cursor: pointer; list-style: none; margin: 18px 0 6px; }
  #${panelId} details.prs-filesbox > summary::-webkit-details-marker, #${panelId} details.prs-allc > summary::-webkit-details-marker { display: none; }
  #${panelId} details.prs-filesbox > summary .prs-h, #${panelId} details.prs-allc > summary .prs-h { display: inline; margin: 0; }
  #${panelId} details.prs-filesbox > summary::before, #${panelId} details.prs-allc > summary::before { content: "▸ "; color: var(--c-muted); font-size: 11px; }
  #${panelId} details.prs-filesbox[open] > summary::before, #${panelId} details.prs-allc[open] > summary::before { content: "▾ "; }
  #${panelId} .prs-allc .prs-cgh { font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
  #${panelId} .prs-allc .prs-comment { margin-bottom: 8px; }
  #${panelId} .prs-allc .prs-comment pre { max-height: 5.5em; overflow: auto; }
  #${panelId} .prs-cstate .prs-cdraft { font-weight: 600; }
  #${panelId} details.prs-filesbox > summary .prs-sum { font-size: 12px; color: var(--c-muted); margin-left: 6px; }
  #${panelId} .prs-msg:empty { display: none; }
  #${panelId} .prs-body { flex: 1; overflow: auto; padding: 4px 16px 24px; }
  #${panelId} h2.prs-h { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--c-muted); margin: 18px 0 6px; }
  #${panelId} ol.prs-map { margin: 0; padding-left: 0; list-style: none; counter-reset: none; }
  #${panelId} ol.prs-map li { padding: 1px 6px; border-radius: 4px; cursor: pointer; }
  #${panelId} ol.prs-map li:hover { color: var(--c-accent); }
  #${panelId} ol.prs-map li.prs-current { background: var(--c-accent-bg); font-weight: 600; color: var(--c-accent); }
  #${panelId} ol.prs-map .prs-count { color: var(--c-muted); font-weight: 400; }
  #${panelId} .prs-md h1, #${panelId} .prs-md h2, #${panelId} .prs-md h3, #${panelId} .prs-md h4 { margin: 16px 0 6px; line-height: 1.3; }
  #${panelId} .prs-md h1 { font-size: 18px; } #${panelId} .prs-md h2 { font-size: 16px; } #${panelId} .prs-md h3 { font-size: 15px; } #${panelId} .prs-md h4 { font-size: 14px; }
  #${panelId} .prs-md p { margin: 0 0 10px; }
  #${panelId} .prs-md ul, #${panelId} .prs-md ol { margin: 0 0 10px; padding-left: 22px; }
  #${panelId} .prs-md li { margin: 2px 0; }
  #${panelId} .prs-md li > ul, #${panelId} .prs-md li > ol { margin: 2px 0 0; }
  #${panelId} code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); padding: 1px 4px; border-radius: 4px; }
  #${panelId} pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
  #${panelId} pre code { background: none; padding: 0; }
  #${panelId} blockquote { margin: 0 0 10px; padding: 0 10px; border-left: 3px solid var(--c-border); color: var(--c-muted); }
  #${panelId} a { color: var(--c-accent); }
  #${panelId} [data-rel] { color: var(--c-accent); cursor: pointer; }
  #${panelId} [data-rel]:hover { text-decoration: underline; }
  #${panelId} [data-rel]:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; text-decoration: underline; }
  #${panelId} .prs-pill { font-size: 11px; padding: 0 5px; border-radius: 9px; border: 1px solid currentColor; margin-left: 3px; white-space: nowrap; }
  #${panelId} button.prs-mark { font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 9px; border: 1px solid currentColor; background: var(--c-bg); cursor: pointer; margin-left: 3px; white-space: nowrap; }
  #${panelId} button.prs-mark:hover { background: var(--c-subtle); }
  #${panelId} ul.prs-files button.prs-mark { margin: 2px 0 0; }
  #${panelId} .prs-st-mark { color: var(--c-ok); } #${panelId} .prs-st-later { color: var(--c-warn); } #${panelId} .prs-st-done, #${panelId} .prs-st-viewed { color: var(--c-muted); }
  #${panelId} .prs-viewed { color: var(--c-ok); font-size: 12px; margin-left: 4px; white-space: nowrap; }
  #${panelId} .prs-viewed:empty { display: none; }
  #${panelId} .prs-comment { margin: 0 0 12px; }
  #${panelId} .prs-comment.prs-c-done { margin: 0 0 6px; padding: 4px 8px; border: 1px dashed var(--c-border); border-radius: 6px; font-size: 12px; color: var(--c-muted); }
  #${panelId} .prs-comment.prs-c-done pre, #${panelId} .prs-comment.prs-c-done .prs-copy { display: none; }
  #${panelId} .prs-comment.prs-c-pending { border-color: var(--c-warn); }
  #${panelId} .prs-cstate { font-size: 12px; color: var(--c-muted); margin-top: 2px; }
  #${panelId} .prs-cstate .prs-ok { color: var(--c-ok); font-weight: 600; }
  #${panelId} .prs-cstate .prs-pend { color: var(--c-warn); font-weight: 600; }
  #${panelId} .prs-cstate .prs-cerr { color: var(--c-err); }
  #${panelId} .prs-cstate .prs-cnote { display: block; }
  #${panelId} .prs-cstate button.prs-linkish { font-size: 12px; }
  #${panelId} .prs-draftsum { text-transform: none; letter-spacing: 0; font-weight: 400; }
  #${panelId} .prs-drafttoggles { margin: -2px 0 6px; }
  #${panelId} .prs-drafttoggles:empty { display: none; }
  #${panelId} pre.prs-script { max-height: 160px; overflow: auto; font-size: 11px; }
  #${panelId} .prs-cbtns button + button { margin-left: 4px; }
  #${panelId} .prs-comment .prs-where { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--c-muted); margin-bottom: 4px; }
  #${panelId} ul.prs-files { list-style: none; padding: 0; margin: 0; font-size: 12px; }
  #${panelId} ul.prs-files > li { padding: 4px 0; border-bottom: 1px solid var(--c-border); }
  #${panelId} ul.prs-files > li:last-child { border-bottom: 0; }
  #${panelId} ul.prs-files .prs-why { color: var(--c-muted); display: block; }
  #${panelId} ul.prs-files .prs-missing { opacity: .6; }
  #${panelId} ul.prs-lines { list-style: none; margin: 2px 0 0 12px; padding: 0; }
  #${panelId} ul.prs-lines li { padding: 1px 0; }
  #${panelId} .prs-empty { color: var(--c-muted); font-style: italic; }
  #${panelId} .prs-quiet { color: var(--c-muted); font-size: 12px; margin: 4px 0 8px; }
  #${panelId} .prs-qa { margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 6px; }
  #${panelId} .prs-qa .prs-q { font-weight: 600; white-space: pre-wrap; }
  #${panelId} .prs-qa .prs-qmeta { font-size: 11px; color: var(--c-muted); }
  #${panelId} .prs-qa .prs-a { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--c-border); }
  #${panelId} .prs-qa .prs-wait { margin-top: 4px; font-size: 12px; color: var(--c-muted); font-style: italic; }
  #${panelId} button.prs-linkish { border: 0; background: none; padding: 0 2px; color: var(--c-muted); font-size: 11px; text-decoration: underline dotted; }
  #${panelId} button.prs-linkish:hover { color: var(--c-accent); }
  #${panelId} .prs-ask { border-top: 1px solid var(--c-border); padding: 8px 10px; display: flex; gap: 6px; align-items: flex-end; background: var(--c-subtle); }
  #${panelId} .prs-ask textarea { flex: 1; min-height: 34px; max-height: 160px; resize: vertical; font: inherit; font-size: 13px; color: var(--c-fg);
    background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; padding: 5px 8px; }
  #${panelId} .prs-ask.prs-off { display: none; }
  #${panelId}.prs-collapsed .prs-ask, #${panelId}.prs-collapsed .prs-note, #${panelId}.prs-collapsed .prs-body, #${panelId}.prs-collapsed .prs-grip, #${panelId}.prs-collapsed .prs-bar > :not(.prs-toggle) { display: none; }
  #${panelId}.prs-collapsed .prs-bar { flex-direction: column; height: 100%; padding: 8px 4px; border: 0; }
  #${panelId}.prs-collapsed .prs-toggle { writing-mode: vertical-rl; padding: 8px 3px; }
  `;
