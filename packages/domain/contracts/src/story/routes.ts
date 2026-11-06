/*
 * A story's calls, /api/stories/<id>/...: the panel's state, questions, drafts, notes, fixes, approval and shipping.
 * The read-only key reaches the ones the page-key.ts list names; the rest take the story's full key. Nothing here
 * runs valibot: a body's type comes from the schemas by `import type`, which is erased.
 */
import { story, type In } from '../route-kit.ts';
import type { BridgeStatus, ListenSessions, ListenTyped, Ok, Prefs } from '../bridge/types.ts';
import type { UsageAnswer } from '@once-upon-a-diff/terms/usage-actions';
import type {
  Freshness,
  PanelUi,
  Pulse,
  ReadInfo,
  ReadMark,
  RebuildAnswer,
  WorkingMark,
} from '../panel/types.ts';
import type { DraftsAnswer, FixesView, Question, QuestionMarksAnswer } from '../review/types.ts';
import type {
  Approval,
  NoteAnswer,
  NoteUpdateAnswer,
  PrPushAnswer,
  PrView,
  PushAnswer,
  PushView,
  StoryData,
  ViewedAnswer,
} from './types.ts';

/** The story panel's saved state, as GET and POST .../ui answer. */
export type SavedUi = Partial<PanelUi> & { hidden?: boolean; at?: string };

export const STORY_ROUTES = {
  story: story<undefined, StoryData>('GET', '', 'token+page+view'),
  storyVersion: story<undefined, { version: string }>('GET', 'version', 'token+page+view'),
  storyPulse: story<undefined, Pulse>('GET', 'pulse', 'token+page+view'),
  storySeen: story<undefined, Ok>('POST', 'seen', 'token+page+view'),
  storyUiRead: story<undefined, SavedUi>('GET', 'ui', 'token+page+view'),
  storyUiWrite: story<In<'ui'>, SavedUi>('POST', 'ui', 'token+page+view'),
  storyPosition: story<In<'position'>, Ok>('POST', 'position', 'token+page+view'),
  storyFreshness: story<undefined, Freshness>('GET', 'freshness', 'token+page+view'),
  storyRebuildRead: story<undefined, RebuildAnswer>('GET', 'rebuild', 'token+page+view'),
  storyRebuildWrite: story<In<'rebuild'>, RebuildAnswer>('POST', 'rebuild', 'token+page+view'),
  storyStatus: story<undefined, BridgeStatus>('GET', 'status', 'token+page+view'),
  storyPrefsRead: story<undefined, Prefs>('GET', 'prefs', 'token+page+view'),
  storyPrefsWrite: story<In<'prefs'>, Prefs>('POST', 'prefs', 'token+page+view'),
  questionsRead: story<undefined, { questions: Question[] }>('GET', 'questions', 'token+page+view'),
  questionAsk: story<In<'questionAsk'>, Question>('POST', 'questions', 'token+page+view'),
  questionMarks: story<In<'questionMarks'>, QuestionMarksAnswer>(
    'POST',
    'questions',
    'token+page+view',
    'marks',
  ),
  draftsRead: story<undefined, DraftsAnswer>('GET', 'drafts', 'token+page+view'),
  draftsAct: story<In<'draftsAct'>, DraftsAnswer>('POST', 'drafts', 'token+page+view'),
  readRead: story<undefined, ReadInfo>('GET', 'read', 'token+page+view'),
  readNote: story<In<'readNote'>, ReadMark>('POST', 'read', 'token+page+view'),
  viewed: story<In<'viewed'>, ViewedAnswer>('POST', 'viewed', 'token+page+view'),
  noteAdd: story<In<'noteAdd'>, NoteAnswer>('POST', 'notes', 'token+page+view'),
  noteUpdate: story<In<'noteUpdate'>, NoteUpdateAnswer, { id: string; note: string }>(
    'POST',
    'notes',
    'token+page+view',
    ':note',
  ),
  fixesRead: story<undefined, FixesView>('GET', 'fixes', 'token+page+view'),
  fixesAct: story<In<'fixesAct'>, FixesView & { sent?: unknown }>(
    'POST',
    'fixes',
    'token+page+view',
  ),
  working: story<undefined, { marks?: WorkingMark[] }>('GET', 'working', 'token+page+view'),
  prView: story<undefined, PrView>('GET', 'pr', 'token+page+view'),
  storyUsageCount: story<In<'usage'>, UsageAnswer>('POST', 'usage', 'token+page+view'),
  storyListenSessions: story<undefined, ListenSessions>('GET', 'listen', 'token+page'),
  storyListen: story<In<'listen'>, ListenTyped>('POST', 'listen', 'token+page'),
  approve: story<In<'approve'>, Approval>('POST', 'approve', 'token+page'),
  prPush: story<In<'prPush'>, PrPushAnswer>('POST', 'pr', 'token+page'),
  pushView: story<undefined, PushView>('GET', 'push', 'token+page'),
  pushApproved: story<In<'pushApproved'>, PushAnswer>('POST', 'push', 'token+page'),
} as const;
