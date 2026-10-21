/*
 * The backstory a story carries (optional, always secondary to the result
 * story): a chapter's or a file's notes, and the story-level summary,
 * sessions and timeline, falling back to the draft `diff-story backstory`
 * wrote to backstory.json.
 */

const clipString = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const turnOf = (turn) => (turn !== null && turn !== '' && Number.isFinite(+turn) ? +turn : null);
const stepOf = (step) =>
  step && typeof step === 'object'
    ? {
        at: clipString(step.at, 40) || null,
        text: clipString(step.text, 2000),
        session: clipString(step.session, 80) || null,
        turn: turnOf(step.turn),
        agent: clipString(step.agent, 80) || null,
      }
    : null;

/** A chapter's or a file's backstory: {summary|text, steps: [{at, text, session, turn, agent}]}. A string is a summary. */
export function backstoryOf(backstory) {
  if (!backstory) {
    return null;
  }
  if (typeof backstory === 'string') {
    return { summary: backstory, text: backstory, steps: [] };
  }
  if (typeof backstory !== 'object') {
    return null;
  }
  const out = {
    summary: clipString(backstory.summary, 4000),
    text: clipString(backstory.text || backstory.summary, 4000),
    steps: (Array.isArray(backstory.steps) ? backstory.steps : [])
      .map(stepOf)
      .filter((step) => step && step.text),
  };
  return out.summary || out.text || out.steps.length ? out : null;
}

function planOf(plan) {
  if (plan && typeof plan === 'object') {
    return plan;
  }
  return typeof plan === 'string' ? { summary: plan } : {};
}

function timelineOf(plan, found) {
  if (Array.isArray(plan.timeline) && plan.timeline.length) {
    return plan.timeline;
  }
  return found && Array.isArray(found.timeline) ? found.timeline : [];
}

/**
 * The story-level backstory: chapters.json's `backstory` ({summary, sessions, timeline}),
 * with the timeline and sessions falling back to the draft in backstory.json
 * (written by `diff-story backstory`) when the story doesn't give its own.
 */
export function storyBackstory(rawPlan, rawFound) {
  const plan = planOf(rawPlan);
  const found = rawFound && rawFound.found ? rawFound : null;
  const momentLines = (id) => {
    const moment = found && found.moments ? found.moments.find((item) => item.id === id) : null;
    return moment ? moment.lines : null;
  };
  const timeline = timelineOf(plan, found)
    .map((moment) => ({
      ...stepOf(moment),
      title: clipString(moment.title, 200),
      asked: clipString(moment.asked, 1000),
      files: Array.isArray(moment.files)
        ? moment.files.filter((file) => typeof file === 'string')
        : [],
      lines:
        moment.lines && typeof moment.lines === 'object'
          ? moment.lines
          : momentLines(moment.moment) || {},
    }))
    .filter((moment) => moment.title || moment.text);
  let sessions = [];
  if (Array.isArray(plan.sessions) && plan.sessions.length) {
    sessions = plan.sessions;
  } else if (found) {
    sessions = found.sessions;
  }
  sessions = sessions
    .map((session) => ({
      id: clipString(session.id, 80),
      label: clipString(session.label || session.title, 200),
    }))
    .filter((session) => session.id);
  const summary = clipString(plan.summary, 6000);
  return summary || timeline.length || sessions.length ? { summary, sessions, timeline } : null;
}
