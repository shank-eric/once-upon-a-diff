/*
 * What the backstory hands on: a first draft of the chronological view, and
 * the brief Claude reads to write the "How it got here" notes.
 */
import { clip } from './text.mjs';

/** A first draft of the chronological view, one entry per moment. The story writer rewrites the text. */
export function draftTimeline(moments) {
  return moments.map((moment) => {
    const ask = moment.asks.find((ask) => ask.who === 'user') || moment.asks[0];
    const did = [
      moment.edits.length
        ? `${moment.edits.length} edit${moment.edits.length === 1 ? '' : 's'}`
        : '',
      moment.shell.length
        ? `${moment.shell.length} scripted change${moment.shell.length === 1 ? '' : 's'}`
        : '',
      moment.commits.length
        ? `commit${moment.commits.length === 1 ? '' : 's'} ${moment.commits.join(', ')}`
        : '',
      moment.checks.length
        ? `${moment.checks.length} check${moment.checks.length === 1 ? '' : 's'} (${moment.checks.filter((check) => check.ok === false).length} failed)`
        : '',
    ]
      .filter(Boolean)
      .join(', ');
    return {
      at: moment.at,
      title: moment.task || clip(moment.prompt, 60) || 'Work in this session',
      asked: ask ? clip(ask.text, 280) : '',
      text: did ? `${did[0].toUpperCase()}${did.slice(1)}.` : '',
      files: moment.files,
      session: moment.session,
      turn: moment.turn,
      agent: moment.agent_name || moment.agent,
      moment: moment.id,
    };
  });
}

/** What Claude reads to write the backstory: the evidence, without the line indexes. */
export function briefOf(backstory) {
  return {
    found: backstory.found,
    reason: backstory.reason || null,
    window: backstory.window,
    commits: backstory.commits.map((commit) => ({
      short: commit.short,
      at: commit.at,
      subject: commit.subject,
      files: commit.files.length,
      made_in: commit.made_in,
    })),
    sessions: backstory.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      agents: session.agents,
    })),
    moments: backstory.moments.map((moment) => ({
      id: moment.id,
      at: moment.at,
      until: moment.until,
      session: moment.session.slice(0, 8),
      turn: moment.turn,
      agent: moment.agent_name || moment.agent,
      task: moment.task,
      asks: moment.asks.map((ask) => `[${ask.at.slice(11, 16)}Z ${ask.via}] ${ask.text}`),
      said: moment.said.map((said) => `[${said.at.slice(11, 16)}Z] ${said.text}`),
      reports: moment.reports.map((report) => `[${report.at.slice(11, 16)}Z] ${report.text}`),
      edits: moment.edits.map(
        (e) =>
          `${e.rel} ${e.tool} +${e.stats ? e.stats.added : 0}/-${e.stats ? e.stats.removed : 0}${e.lines.length ? ` lines ${e.lines.map((range) => range.join('-')).join(',')}` : ''}`,
      ),
      commits: moment.commits,
      checks: moment.checks.map(
        (check) => `${check.ok === false ? 'FAIL' : 'ok'} ${check.category}: ${check.command}`,
      ),
      shell: moment.shell.length,
      files: moment.files.length,
    })),
    unmatched: backstory.unmatched,
  };
}
