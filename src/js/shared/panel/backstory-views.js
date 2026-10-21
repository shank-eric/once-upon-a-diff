/*
 * Backstory (optional, from the Claude Code sessions that made the change).
 * The result story always leads: a chapter's backstory is a collapsed
 * "Backstory" section under its narrative, a file row gets a small "why" link
 * that opens its "How it got here", and the Overview has the summary. The
 * secondary "Backstory view" switches the whole panel to the chronological
 * telling, one step per moment of work (momentHtml).
 */
import { escapeHtml } from '../util/html.js';
import { shortDateTime } from '../util/time.js';

/** The first sentence of a text, on one line, at most 240 characters. */
export function firstSentence(text) {
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(String(text).replace(/\n+/g, ' '));
  return (match ? match[0] : String(text)).trim().slice(0, 240);
}

export function createBackstoryViews(context) {
  const { story } = context;
  const { sessions } = story;
  const inline = (text) => context.markdown.inline(text);
  const markdown = (text) => context.markdown.markdown(text);

  /** "session d5c52a31 · turn 7 · agent": copies the resume command when clicked. */
  function sessionRef(moment) {
    if (!moment || !moment.session) {
      return '';
    }
    const sessionId = String(moment.session);
    const label = [
      `session ${sessionId.slice(0, 8)}`,
      moment.turn != null ? `turn ${moment.turn}` : '',
      moment.agent ? String(moment.agent) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const fullId = (sessions.get(sessionId) || {}).id || sessionId;
    const turn = moment.turn != null ? `, turn ${moment.turn}` : '';
    return `<button class="prs-sess" data-copy-text="${escapeHtml(`claude --resume ${fullId}`)}" title="${escapeHtml(`Claude Code session ${fullId}${turn}. Click to copy the resume command.`)}">${escapeHtml(label)}</button>`;
  }

  /** Dated steps, each with its session. */
  function stepsHtml(list) {
    const items = (list || []).filter((item) => item && item.text);
    if (!items.length) {
      return '';
    }
    const rows = items.map((item) => {
      const when = item.at
        ? `<span class="prs-bs-at">${escapeHtml(shortDateTime(item.at))}</span>`
        : '';
      return `<li>${when}${inline(item.text)} ${sessionRef(item)}</li>`;
    });
    return `<ol class="prs-bs-steps">${rows.join('')}</ol>`;
  }

  /** A collapsed "Backstory" section: a short summary, then dated steps. */
  function backstoryBlock(backstory, extra = '') {
    if (!backstory || (!backstory.summary && !(backstory.steps || []).length && !extra)) {
      return '';
    }
    const summary = backstory.summary
      ? `<div class="prs-md">${markdown(backstory.summary)}</div>`
      : '';
    return (
      `<details class="prs-backstory"><summary>Backstory <span class="prs-sub">· how it got here</span></summary><div class="prs-bs-body">` +
      `${summary}${stepsHtml(backstory.steps)}${extra}</div></details>`
    );
  }

  /** A file's "How it got here": its own note, else the backstory moments that touched it. */
  function fileBackstory(file) {
    const own =
      file.backstory && (file.backstory.text || (file.backstory.steps || []).length)
        ? file.backstory
        : null;
    const lineNotes = (file.lines || [])
      .filter((line) => line.backstory)
      .map((line) => {
        const range = line.end !== line.start ? `s ${line.start}–${line.end}` : ` ${line.start}`;
        return { text: `${line.side === 'L' ? 'old ' : ''}line${range}: ${line.backstory}` };
      });
    // with its own note, the moments that touched the file only name themselves; without one, each says what it did
    const moments = story.timeline
      .filter((moment) => (moment.files || []).includes(file.rel))
      .map((moment) => ({
        at: moment.at,
        text: `**${moment.title}**${moment.text && !own ? `: ${firstSentence(moment.text)}` : ''}`,
        session: moment.session,
        turn: moment.turn,
        agent: moment.agent,
      }));
    if (!own && !lineNotes.length && !moments.length) {
      return '';
    }
    const steps = own && (own.steps || []).length ? own.steps : moments;
    const ownText = own && own.text ? `<p>${inline(own.text)}</p>` : '';
    const notes = lineNotes.map((note) => `<p>${inline(note.text)}</p>`).join('');
    return `${ownText}${notes}${stepsHtml(steps)}`;
  }

  /** The backstory view's text for one moment. */
  function momentHtml(step) {
    const moment = step.entry;
    const when = moment.at
      ? `<span class="prs-bs-at">${escapeHtml(shortDateTime(moment.at))}</span>`
      : '';
    const asked = moment.asked
      ? `<blockquote class="prs-asked">${inline(moment.asked)}</blockquote>`
      : '';
    return (
      `<h3>${escapeHtml(step.title)}</h3><p>${when}${sessionRef(moment)}</p>` +
      `${asked}${moment.text ? markdown(moment.text) : ''}`
    );
  }

  /** "From 2 Claude Code sessions:" and each session, with its resume command. */
  function sessionsHtml() {
    if (!sessions.size) {
      return '';
    }
    const items = [...sessions.values()]
      .map(
        (session) =>
          `<li>${escapeHtml(session.label || session.title || session.id.slice(0, 8))} ${sessionRef({ session: session.id })}</li>`,
      )
      .join('');
    return `<p class="prs-bs-at">From ${sessions.size} Claude Code session${sessions.size === 1 ? '' : 's'}:</p><ul>${items}</ul>`;
  }

  return { sessionRef, stepsHtml, backstoryBlock, fileBackstory, momentHtml, sessionsHtml };
}
