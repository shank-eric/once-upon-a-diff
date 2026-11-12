/** The states an agent run can be in: open ones while it goes on (a gate or a wait included), end ones once it is over. */
export const OPEN_STATES = ['running', 'waiting', 'review', 'plan', 'fixing'] as const;
export const END_STATES = ['done', 'failed', 'stopped'] as const;

/** Whether a run's state says it is over. */
export const isEndState = (state: string): boolean =>
  (END_STATES as readonly string[]).includes(state);
