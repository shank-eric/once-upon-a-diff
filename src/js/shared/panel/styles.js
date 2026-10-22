/*
 * The panel's CSS. Primer variables, so GitHub's light and dark themes carry
 * over (the local page defines the same variables).
 */

/**
 * The few rules the host page gets, all keyed to the panel's own id, class and data-ou-* attributes:
 * docking (the page's right margin), hiding other chapters' files and flashing a jump's target.
 */
export const documentCss = (hostId) => `
  html.${hostId}-docked body { margin-right: var(--ou-w) !important; }
  #${hostId} { all: initial; }
  [data-ou-hidden] { display: none !important; }
  [data-ou-flash] { outline: 2px solid var(--fgColor-accent, #0969da) !important; outline-offset: 2px; border-radius: 6px; }
  tr[data-ou-flash] { outline: none !important; }
  tr[data-ou-flash] > td { background-color: var(--bgColor-attention-muted, #fff8c5) !important; box-shadow: inset 0 0 0 9999px rgba(212,167,44,.12); }
  `;

/** Everything else, inside the panel's shadow root, so the page's CSS (and other extensions') can't reach it, nor it them. */
export const panelCss = (panelId) => `
  :host { all: initial; }
  #${panelId}:focus { outline: none; }
  #${panelId} { --c-bg: var(--bgColor-default, #fff); --c-fg: var(--fgColor-default, #1f2328); --c-muted: var(--fgColor-muted, #59636e);
    --c-border: var(--borderColor-default, #d1d9e0); --c-subtle: var(--bgColor-muted, #f6f8fa); --c-accent: var(--fgColor-accent, #0969da);
    --c-accent-bg: var(--bgColor-accent-muted, #ddf4ff); --c-ok: var(--fgColor-success, #1a7f37); --c-warn: var(--fgColor-attention, #9a6700); --c-err: var(--fgColor-danger, #d1242f);
    position: fixed; top: 0; right: 0; bottom: 0; width: var(--ou-w); z-index: 99; box-sizing: border-box;
    background: var(--c-bg); color: var(--c-fg); border-left: 1px solid var(--c-border);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column; box-shadow: -4px 0 12px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { #${panelId} { --c-bg: var(--bgColor-default, #0d1117); --c-fg: var(--fgColor-default, #f0f6fc);
    --c-muted: var(--fgColor-muted, #9198a1); --c-border: var(--borderColor-default, #3d444d); --c-subtle: var(--bgColor-muted, #151b23);
    --c-accent: var(--fgColor-accent, #4493f8); --c-accent-bg: var(--bgColor-accent-muted, #388bfd1a);
    --c-ok: var(--fgColor-success, #3fb950); --c-warn: var(--fgColor-attention, #d29922); --c-err: var(--fgColor-danger, #f85149); } }
  #${panelId} * { box-sizing: border-box; }
  #${panelId} .ou-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; }
  #${panelId} .ou-grip:hover, #${panelId}.ou-dragging .ou-grip { background: var(--c-accent); opacity: .35; }
  #${panelId} .ou-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--c-border); background: var(--c-subtle); }
  #${panelId} .ou-bar .ou-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${panelId} button { font: inherit; font-size: 12px; color: var(--c-fg); background: var(--c-bg); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #${panelId} button:hover:not(:disabled) { border-color: var(--c-accent); }
  #${panelId} button:disabled { opacity: .45; cursor: default; }
  #${panelId} button[aria-pressed="true"] { background: var(--c-accent-bg); border-color: var(--c-accent); }
  #${panelId} .ou-note { padding: 6px 12px; font-size: 12px; color: var(--c-muted); border-bottom: 1px solid var(--c-border);
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  #${panelId} .ou-note b { color: var(--c-fg); }
  #${panelId} .ou-msg { flex-basis: 100%; color: var(--c-warn); }
  #${panelId} button.ou-light { border: 0; background: none; padding: 2px 4px; }
  #${panelId} .ou-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--c-muted); vertical-align: middle; }
  #${panelId} .ou-light[data-level="ok"] .ou-dot { background: var(--c-ok); }
  #${panelId} .ou-light[data-level="warn"] .ou-dot { background: var(--c-warn); }
  #${panelId} .ou-light[data-level="error"] .ou-dot { background: var(--c-err); }
  #${panelId} .ou-health { flex-basis: 100%; margin: 2px 0; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-bg); }
  #${panelId} .ou-health ul { list-style: none; margin: 0; padding: 0; }
  #${panelId} .ou-health li { padding: 1px 0; }
  #${panelId} .ou-health .ou-hok { color: var(--c-ok); } #${panelId} .ou-health .ou-hwarn { color: var(--c-warn); } #${panelId} .ou-health .ou-herr { color: var(--c-err); }
  #${panelId} .ou-fresh { flex-basis: 100%; font-size: 12px; }
  #${panelId} .ou-fresh:empty { display: none; }
  #${panelId} .ou-fresh.ou-stale { color: var(--c-warn); }
  #${panelId} .ou-fresh button { margin-left: 6px; }
  #${panelId} .ou-rebuilding { flex-basis: 100%; font-size: 12px; color: var(--c-muted); }
  #${panelId} .ou-rebuilding.ou-failed { color: var(--c-warn); }
  #${panelId} .ou-rebuild-box { margin: 12px 0 4px; }
  #${panelId} .ou-rebuild-box:empty { display: none; }
  #${panelId} .ou-rebuild-form textarea { box-sizing: border-box; width: 100%; min-height: 54px; resize: vertical; font: inherit; font-size: 13px; color: var(--c-fg);
    background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; padding: 6px 8px; }
  #${panelId} .ou-rebuild-btns { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  #${panelId} .ou-chg { font-size: 11px; color: var(--c-warn); margin-left: 4px; white-space: nowrap; }
  #${panelId} .ou-cstate .ou-cstale { color: var(--c-warn); }
  #${panelId} .ou-new { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--c-accent); border: 1px solid currentColor; border-radius: 9px; padding: 0 5px; }
  #${panelId} .ou-since { margin: 10px 0; padding: 6px 10px; border-left: 3px solid var(--c-accent); background: var(--c-accent-bg); border-radius: 0 6px 6px 0; font-size: 12px; }
  #${panelId} .ou-askhint { padding: 6px 10px 0; font-size: 12px; color: var(--c-warn); background: var(--c-subtle); border-top: 1px solid var(--c-border); }
  #${panelId} .ou-askhint code { font-size: 11px; }
  #${panelId} .ou-askwho { padding: 6px 10px 0; font-size: 12px; color: var(--c-muted); background: var(--c-subtle); border-top: 1px solid var(--c-border); }
  #${panelId} .ou-askhint:not([hidden]) + .ou-askwho { border-top: 0; }
  #${panelId} .ou-askwho .ou-copystory { margin-left: 4px; }
  #${panelId} .ou-askwho .ou-prompt { white-space: pre-wrap; word-break: break-all; font-size: 11px; margin: 4px 0 0; color: var(--c-fg); }
  #${panelId} .ou-askhint .ou-copyprompt { margin-left: 4px; }
  #${panelId} .ou-askhint .ou-promptmore { border: 0; background: none; padding: 0 2px; color: var(--c-accent, inherit); text-decoration: underline; cursor: pointer; font-size: 11px; }
  #${panelId} .ou-askhint .ou-promptlong, #${panelId} .ou-askhint .ou-prompt { white-space: pre-wrap; word-break: break-all; font-size: 11px; margin: 4px 0 0; color: var(--c-fg); }
  #${panelId} .ou-progress { margin: 0 0 10px; padding: 4px 8px; font-size: 12px; color: var(--c-muted); border-left: 3px solid var(--c-border); }
  #${panelId} .ou-progress:empty { display: none; }
  #${panelId} .ou-progress.ou-complete { border-left-color: var(--c-ok); }
  #${panelId} .ou-early-box { margin: 0 0 10px; padding: 6px 8px; font-size: 12px; border: 1px solid var(--c-warn); border-radius: 6px; }
  #${panelId} .ou-early-box:empty { display: none; }
  #${panelId} .ou-early-box p { margin: 0 0 3px; }
  #${panelId} .ou-viewed.ou-early { color: var(--c-warn); }
  #${panelId} .ou-progress .ou-done { color: var(--c-ok); font-weight: 600; }
  #${panelId} .ou-progress b { color: var(--c-fg); }
  #${panelId} .ou-stepprog { font-size: 11px; color: var(--c-muted); margin-left: 4px; }
  #${panelId} .ou-stepprog.ou-done { color: var(--c-ok); }
  #${panelId} details.ou-filesbox > summary, #${panelId} details.ou-allc > summary { cursor: pointer; list-style: none; margin: 18px 0 6px; }
  #${panelId} details.ou-filesbox > summary::-webkit-details-marker, #${panelId} details.ou-allc > summary::-webkit-details-marker { display: none; }
  #${panelId} details.ou-filesbox > summary .ou-h, #${panelId} details.ou-allc > summary .ou-h { display: inline; margin: 0; }
  #${panelId} details.ou-filesbox > summary::before, #${panelId} details.ou-allc > summary::before { content: "▸ "; color: var(--c-muted); font-size: 11px; }
  #${panelId} details.ou-filesbox[open] > summary::before, #${panelId} details.ou-allc[open] > summary::before { content: "▾ "; }
  #${panelId} .ou-allc .ou-cgh { font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
  #${panelId} .ou-allc .ou-comment { margin-bottom: 8px; }
  #${panelId} .ou-allc .ou-comment pre { max-height: 5.5em; overflow: auto; }
  #${panelId} .ou-cstate .ou-cdraft { font-weight: 600; }
  #${panelId} details.ou-filesbox > summary .ou-sum { font-size: 12px; color: var(--c-muted); margin-left: 6px; }
  #${panelId} .ou-msg:empty { display: none; }
  #${panelId} .ou-body { flex: 1; overflow: auto; padding: 4px 16px 24px; }
  #${panelId} h2.ou-h { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--c-muted); margin: 18px 0 6px; }
  #${panelId} ol.ou-map { margin: 0; padding-left: 0; list-style: none; counter-reset: none; }
  #${panelId} ol.ou-map li { padding: 1px 6px; border-radius: 4px; cursor: pointer; }
  #${panelId} ol.ou-map li:hover { color: var(--c-accent); }
  #${panelId} ol.ou-map li.ou-current { background: var(--c-accent-bg); font-weight: 600; color: var(--c-accent); }
  #${panelId} ol.ou-map .ou-count { color: var(--c-muted); font-weight: 400; }
  #${panelId} .ou-md h1, #${panelId} .ou-md h2, #${panelId} .ou-md h3, #${panelId} .ou-md h4 { margin: 16px 0 6px; line-height: 1.3; }
  #${panelId} .ou-md h1 { font-size: 18px; } #${panelId} .ou-md h2 { font-size: 16px; } #${panelId} .ou-md h3 { font-size: 15px; } #${panelId} .ou-md h4 { font-size: 14px; }
  #${panelId} .ou-md p { margin: 0 0 10px; }
  #${panelId} .ou-md ul, #${panelId} .ou-md ol { margin: 0 0 10px; padding-left: 22px; }
  #${panelId} .ou-md li { margin: 2px 0; }
  #${panelId} .ou-md li > ul, #${panelId} .ou-md li > ol { margin: 2px 0 0; }
  #${panelId} code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); padding: 1px 4px; border-radius: 4px; }
  #${panelId} pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--c-subtle); border: 1px solid var(--c-border);
    border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
  #${panelId} pre code { background: none; padding: 0; }
  #${panelId} blockquote { margin: 0 0 10px; padding: 0 10px; border-left: 3px solid var(--c-border); color: var(--c-muted); }
  #${panelId} a { color: var(--c-accent); }
  #${panelId} [data-rel] { color: var(--c-accent); cursor: pointer; }
  #${panelId} [data-rel]:hover { text-decoration: underline; }
  #${panelId} [data-rel]:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; text-decoration: underline; }
  #${panelId} .ou-pill { font-size: 11px; padding: 0 5px; border-radius: 9px; border: 1px solid currentColor; margin-left: 3px; white-space: nowrap; }
  #${panelId} button.ou-mark { font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 9px; border: 1px solid currentColor; background: var(--c-bg); cursor: pointer; margin-left: 3px; white-space: nowrap; }
  #${panelId} button.ou-mark:hover { background: var(--c-subtle); }
  #${panelId} ul.ou-files button.ou-mark { margin: 2px 0 0; }
  #${panelId} .ou-st-mark { color: var(--c-ok); } #${panelId} .ou-st-later { color: var(--c-warn); } #${panelId} .ou-st-done, #${panelId} .ou-st-viewed { color: var(--c-muted); }
  #${panelId} .ou-viewed { color: var(--c-ok); font-size: 12px; margin-left: 4px; white-space: nowrap; }
  #${panelId} .ou-viewed:empty { display: none; }
  #${panelId} .ou-comment { margin: 0 0 12px; }
  #${panelId} .ou-comment.ou-c-done { margin: 0 0 6px; padding: 4px 8px; border: 1px dashed var(--c-border); border-radius: 6px; font-size: 12px; color: var(--c-muted); }
  #${panelId} .ou-comment.ou-c-done pre, #${panelId} .ou-comment.ou-c-done .ou-copy { display: none; }
  #${panelId} .ou-comment.ou-c-pending { border-color: var(--c-warn); }
  #${panelId} .ou-cstate { font-size: 12px; color: var(--c-muted); margin-top: 2px; }
  #${panelId} .ou-cstate .ou-ok { color: var(--c-ok); font-weight: 600; }
  #${panelId} .ou-cstate .ou-pend { color: var(--c-warn); font-weight: 600; }
  #${panelId} .ou-cstate .ou-cerr { color: var(--c-err); }
  #${panelId} .ou-cstate .ou-cnote { display: block; }
  #${panelId} .ou-cstate button.ou-linkish { font-size: 12px; }
  #${panelId} .ou-draftsum { text-transform: none; letter-spacing: 0; font-weight: 400; }
  #${panelId} .ou-drafttoggles { margin: -2px 0 6px; }
  #${panelId} .ou-drafttoggles:empty { display: none; }
  #${panelId} pre.ou-script { max-height: 160px; overflow: auto; font-size: 11px; }
  #${panelId} .ou-cbtns button + button { margin-left: 4px; }
  #${panelId} .ou-comment .ou-where { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--c-muted); margin-bottom: 4px; }
  #${panelId} ul.ou-files { list-style: none; padding: 0; margin: 0; font-size: 12px; }
  #${panelId} ul.ou-files > li { padding: 4px 0; border-bottom: 1px solid var(--c-border); }
  #${panelId} ul.ou-files > li:last-child { border-bottom: 0; }
  #${panelId} ul.ou-files .ou-why { color: var(--c-muted); display: block; }
  #${panelId} ul.ou-files .ou-missing { opacity: .6; }
  #${panelId} ul.ou-lines { list-style: none; margin: 2px 0 0 12px; padding: 0; }
  #${panelId} ul.ou-lines li { padding: 1px 0; }
  #${panelId} .ou-empty { color: var(--c-muted); font-style: italic; }
  #${panelId} .ou-quiet { color: var(--c-muted); font-size: 12px; margin: 4px 0 8px; }
  #${panelId} .ou-qa { margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--c-border); border-radius: 6px; }
  #${panelId} .ou-qa .ou-qhead { display: flex; gap: 4px; align-items: flex-start; }
  #${panelId} .ou-qa .ou-q { flex: 1; min-width: 0; font-weight: 600; white-space: pre-wrap; }
  #${panelId} .ou-qa-collapsed { padding: 4px 10px; margin-bottom: 6px; }
  #${panelId} .ou-qa-collapsed .ou-q { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${panelId} .ou-qa-dismissed { opacity: .6; }
  #${panelId} .ou-qa .ou-qtoggle { border: 0; background: none; padding: 0 2px; color: var(--c-muted); font-size: 13px; line-height: 18px; cursor: pointer; }
  #${panelId} .ou-qa .ou-qmeta { font-size: 11px; color: var(--c-muted); }
  #${panelId} .ou-qa .ou-aby { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--c-border); font-size: 11px; color: var(--c-muted); }
  #${panelId} .ou-qa .ou-a { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--c-border); }
  #${panelId} .ou-qa .ou-aby + .ou-a { margin-top: 2px; padding-top: 0; border-top: 0; }
  #${panelId} .ou-qtools { margin: -2px 0 8px; }
  #${panelId} .ou-qundo { margin: 0 0 8px; font-size: 12px; color: var(--c-muted); }
  #${panelId} .ou-qa .ou-wait { margin-top: 4px; font-size: 12px; color: var(--c-muted); font-style: italic; }
  #${panelId} button.ou-linkish { border: 0; background: none; padding: 0 2px; color: var(--c-muted); font-size: 11px; text-decoration: underline dotted; }
  #${panelId} button.ou-linkish:hover { color: var(--c-accent); }
  #${panelId} .ou-ask { border-top: 1px solid var(--c-border); padding: 8px 10px; display: flex; gap: 6px; align-items: flex-end; background: var(--c-subtle); }
  #${panelId} .ou-ask textarea { flex: 1; min-height: 34px; max-height: 160px; resize: vertical; font: inherit; font-size: 13px; color: var(--c-fg);
    background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; padding: 5px 8px; }
  #${panelId} .ou-ask.ou-off { display: none; }
  #${panelId}.ou-collapsed .ou-ask, #${panelId}.ou-collapsed .ou-askwho, #${panelId}.ou-collapsed .ou-note, #${panelId}.ou-collapsed .ou-body, #${panelId}.ou-collapsed .ou-grip, #${panelId}.ou-collapsed .ou-bar > :not(.ou-toggle) { display: none; }
  #${panelId}.ou-collapsed .ou-bar { flex-direction: column; height: 100%; padding: 8px 4px; border: 0; }
  #${panelId}.ou-collapsed .ou-toggle { writing-mode: vertical-rl; padding: 8px 3px; }
  `;
