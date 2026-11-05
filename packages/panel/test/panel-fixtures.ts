/*
 * The worlds the panel's DOM test mounts it in: a story with every kind of step, a host page (a fake of the diff page the
 * host adapter reads) and the options a host passes, each answering from a script. The panel's DOM for each is a golden file
 * (fixtures/panel-dom/), so a change that moves a node, an attribute or a word shows as a diff.
 */
import { createHash } from 'node:crypto';
import type {
  Chapter,
  DraftsAnswer,
  FixesView,
  Freshness,
  Question,
  ReadInfo,
  StoryData,
  WorkingMark,
} from '@once-upon-a-diff/protocol/types';
import type { HostPage, FileBlock, PanelHost } from '../src/host/host.ts';
import type { PanelOptions } from '../src/host/context.ts';

const sha = (rel: string) => createHash('sha256').update(rel).digest('hex');
export const RELS = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'README.md'];

const chapter = (extra: Partial<Chapter>): Chapter => ({
  key: '',
  title: '',
  headline: '',
  scenario: '',
  summary: '',
  narrative: '',
  files: [],
  refs: [],
  comments: [],
  ...extra,
});

/** A story with four chapters (told, with drafts, still being written, and a "Since you read it" one) and an Overview. */
export function story(): StoryData {
  const hunks = Array.from({ length: 14 }, (_, i) => ({
    ref: `src/c.ts:${40 + i * 10}-${50 + i * 10}`,
    side: 'R' as const,
    start: 40 + i * 10,
    end: 50 + i * 10,
  }));
  return {
    id: 'story-1',
    kind: 'github',
    version: 'v1',
    pr: {
      repo: 'acme/widgets',
      number: 7,
      title: 'Add widgets',
      url: 'https://github.com/acme/widgets/pull/7',
    },
    title: 'Widgets',
    overview:
      '# Widgets\n\nThe PR adds a widget in `src/a.ts` and wires it in [the top](ref:top).\n\n1. First `src/b.ts`\n2. Then **everything** else\n\n> A note <b>not bold</b> & more',
    summary: 'Adds widgets.',
    plan: 'Read a, then b.',
    overview_refs: [{ id: 'top', path: 'src/a.ts', side: 'R', start: 1, end: 3 }],
    files: RELS.map((rel) => ({ rel, sha: sha(rel) })),
    chapters: [
      chapter({
        key: 'c1',
        title: 'Chapter 1: Start',
        narrative: `# Chapter 1: Start\n\nIt begins in \`src/a.ts\`, where [the top](ref:top) is set, and goes to [b](https://github.com/acme/widgets/pull/7/changes#diff-${sha('src/b.ts')}R3).\n\n- one\n- two with **bold** and _em_ and \`src/b.ts\`\n\n\`\`\`\nlet x = 1 < 2;\n\`\`\`\n\nSee [docs](https://example.com/a?b=1&c=2).`,
        files: [
          {
            rel: 'src/a.ts',
            partial: true,
            note: 'the top',
            lines: [{ side: 'R', start: 1, end: 3, label: 'the top' }],
          },
          { rel: 'src/b.ts', partial: false, note: null },
        ],
        refs: [{ id: 'top', path: 'src/a.ts', side: 'R', start: 1, end: 3 }],
        comments: [
          { path: 'src/a.ts', line: 2, body: 'Could you confirm this <thing>?' },
          { path: '(general)', line: 0, body: 'A general note' },
        ],
      }),
      chapter({
        key: 'c2',
        title: 'Chapter 2: Finish',
        narrative:
          '# Chapter 2: Finish\n\nNow `src/a.ts` is done, and so is `src/c.ts`, once [the finish](ref:fin) lands.\n\nSecond paragraph.',
        refs: [{ id: 'fin', path: 'src/b.ts', side: 'R', start: 3, end: 3 }],
        files: [
          { rel: 'src/a.ts', partial: false, note: null },
          { rel: 'src/b.ts', partial: false, note: null },
          { rel: 'src/c.ts', partial: false, note: null },
        ],
        comments: [
          { path: 'src/c.ts', line: 7, body: 'Dropped line', side: 'L' },
          { path: 'src/c.ts', line: 9, body: 'Kept from before', carried: true },
          { path: 'src/c.ts', line: 11, body: 'Not in the diff now', unmapped: true },
          { path: 'src/b.ts', line: 3, body: 'Fix me' },
        ],
      }),
      chapter({
        key: 'c3',
        title: 'Chapter 3: Later',
        unwritten: true,
        files: [{ rel: 'README.md', partial: false, note: null }],
      }),
      chapter({
        key: 'c4',
        title: 'Since you read it: new commits',
        narrative: '# Since you read it\n\nTwo commits touched `src/c.ts`.',
        since: { from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 2 },
        files: [{ rel: 'src/c.ts', partial: false, note: null }],
      }),
    ],
    uncovered_hunks: [{ rel: 'src/c.ts', hunks }],
  } as StoryData;
}

/** A story with one chapter that has no comments and no unwritten one: the bare cases. */
export function smallStory(): StoryData {
  const full = story();
  return { ...full, chapters: [full.chapters[0]], uncovered_hunks: [] };
}

export interface PageWorld {
  host: PanelHost;
  /** the diff page's file blocks, in the document */
  blocks: FileBlock[];
  /** what each file's Viewed toggle says (true, false, 'none' for no toggle, null for not on the page) */
  viewed: Map<string, boolean | 'none' | null>;
  /** how many times each file's Viewed toggle was clicked */
  clicks: Map<string, number>;
}

/** A fake diff page: a block per file in the document (what the filter hides), and Viewed toggles that count their clicks. */
export function pageWorld(
  data: StoryData,
  { onPage = RELS }: { onPage?: string[] } = {},
): PageWorld {
  const world = { blocks: [] as FileBlock[], viewed: new Map(), clicks: new Map() } as Omit<
    PageWorld,
    'host'
  >;
  const holder = document.createElement('div');
  holder.id = 'diff-page';
  document.body.appendChild(holder);
  for (const rel of onPage) {
    const el = document.createElement('div');
    el.setAttribute('role', 'region');
    el.id = `diff-${sha(rel)}`;
    el.setAttribute('data-rel', rel);
    holder.appendChild(el);
    world.blocks.push({ rel, el });
    world.viewed.set(rel, false);
  }
  const page = (): HostPage => ({
    isDrawn: () => true,
    labelOf: () => '',
    fileBlocks: () => world.blocks,
    blockOf: (rel) => world.blocks.find((block) => block.rel === rel),
    blocksByPath: () => new Map(world.blocks.map((block) => [block.rel, block])),
    lineCell: () => null,
    viewedToggleIn: (el) => {
      const rel = el.getAttribute('data-rel') as string;
      const toggle = document.createElement('button') as HTMLButtonElement;
      toggle.click = () => {
        world.clicks.set(rel, (world.clicks.get(rel) || 0) + 1);
        world.viewed.set(rel, !world.viewed.get(rel));
      };
      return world.viewed.get(rel) === 'none' ? null : toggle;
    },
    isViewed: (rel) => (world.viewed.has(rel) ? (world.viewed.get(rel) as boolean | 'none') : null),
    isSafeToClick: (el): el is HTMLElement => !!el,
    collapsedToggle: () => null,
    loadDiffButton: () => null,
    expandAllButton: () => null,
    rowModel: () => ({ n: null }),
    treeRows: () => [],
    fileAtTop: () => data.chapters[0]?.files[0]?.rel ?? null,
  });
  return {
    ...world,
    host: {
      createPage: page,
      client: { ask: (() => Promise.reject(new Error('no bridge in this test'))) as never },
      storyId: data.id,
      pageUrl: () => 'https://github.com/acme/widgets/pull/7/changes',
      count: () => {},
    },
  };
}

export const question = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  at: '2026-11-03T11:00:00Z',
  step: 1,
  text: `Why ${id}?`,
  file: null,
  answers: [],
  ...extra,
});

export const QUESTIONS: Question[] = [
  question('q1', { status: { state: 'queued', by: null, since: '2026-11-03T11:30:00Z' } as never }),
  question('q2', {
    step: 2,
    file: 'src/b.ts',
    status: {
      state: 'working',
      by: 'author-1',
      since: '2026-11-03T11:55:00Z',
      note: 'reading',
      note_at: '2026-11-03T11:58:00Z',
    } as never,
  }),
  question('q3', {
    step: 0,
    answers: [
      { at: '2026-11-03T11:10:00Z', text: 'Because `src/a.ts` says so.\n\n- yes', by: 'author-1' },
    ],
  }),
  question('q4', {
    step: 1,
    unread: true,
    answers: [{ at: '2026-11-03T11:20:00Z', text: 'An unread **answer**.' }],
  }),
  question('q5', {
    step: 2,
    collapsed: true,
    answers: [{ at: '2026-11-03T11:21:00Z', text: 'Folded away' }],
  }),
  question('q6', { dismissed: true, channel: 'voice' }),
];

export const DRAFTS: DraftsAnswer = {
  drafts: [
    {
      chapter: 1,
      index: 0,
      status: 'posted',
      dismissed: false,
      url: 'https://github.com/acme/widgets/pull/7#c1',
    },
    { chapter: 1, index: 1, status: 'draft', dismissed: false },
    {
      chapter: 2,
      index: 0,
      status: 'pending',
      dismissed: false,
      url: 'https://github.com/acme/widgets/pull/7#c2',
    },
    { chapter: 2, index: 1, status: 'draft', dismissed: true },
    {
      chapter: 2,
      index: 2,
      status: 'draft',
      dismissed: false,
      added: { at: '2099-01-01T00:00:00Z', url: 'https://github.com/acme/widgets/pull/7#c3' },
    },
    {
      chapter: 2,
      index: 3,
      status: 'draft',
      dismissed: false,
      fix: { path: 'src/b.ts', side: 'R', line: 3, state: 'sent', sent_to: 'author-1' },
    },
  ],
  error: null,
};

export const FIXES: FixesView = {
  notes: [
    {
      id: 'n1',
      at: '2026-11-03T10:00:00Z',
      path: 'src/a.ts',
      line: 2,
      side: 'R',
      body: 'Rename it',
      state: 'draft',
      draft: 'x',
    },
    {
      id: 'n2',
      at: '2026-11-03T10:01:00Z',
      path: 'src/b.ts',
      line: 3,
      side: 'R',
      body: 'Fix me',
      state: 'sent',
      sent: { request: 'r1', to: 'author-1', at: '2026-11-03T10:05:00Z' },
    },
    {
      id: 'n3',
      at: '2026-11-03T10:02:00Z',
      path: 'src/c.ts',
      line: 9,
      side: 'L',
      body: 'Done thing',
      state: 'fixed',
      fixed: { request: 'r0', sha: 'abcdef1234567', by: 'author-1', at: '2026-11-03T10:30:00Z' },
    },
    {
      id: 'n4',
      at: '2026-11-03T10:03:00Z',
      path: 'README.md',
      line: 0,
      side: 'R',
      body: 'Came back',
      state: 'draft',
      returned: {
        request: 'r0',
        sha: 'abcdef1234567',
        why: 'still wrong',
        at: '2026-11-03T10:31:00Z',
      },
    },
  ],
  auto_send: false,
  to: { consumer: 'author-1' },
  requests: [{ id: 'r1', status: 'pending', notes: ['n2'], to: 'author-1' }],
  can_add: true,
};

export const WORKING: WorkingMark[] = [
  {
    consumer: 'author-2',
    files: [
      {
        path: 'src/a.ts',
        ranges: [
          [3, 5],
          [9, 9],
        ],
      },
      { path: 'c.ts' },
    ],
    started_at: '2026-11-03T11:40:00Z',
    at: '2026-11-03T11:50:00Z',
  },
];

export const STALE: Freshness = {
  state: 'stale',
  story_head: '1111111222222233333334444444',
  current_head: '5555555666666677777778888888',
  newer: 3,
  changed_files: ['src/b.ts', 'src/c.ts'],
  chapters_touched: [1, 2],
};
export const CURRENT_UPDATED: Freshness = {
  state: 'current',
  story_head: '5555555666666677777778888888',
  updated: {
    from: '1111111222222233333334444444',
    to: '5555555666666677777778888888',
    newer: 2,
    changed_files: ['src/a.ts'],
    chapters_touched: [1],
  },
};
export const READS: ReadInfo = {
  reads: {},
  changed: [{ step: 2, files: ['src/b.ts'], since: 'abc1234def' }],
  stale_comments: [{ step: 1, index: 0 }],
};

/** Every call a host can make, each answering at once (a call is logged in `calls`). */
export function fullOptions(
  calls: unknown[][],
  overrides: Partial<PanelOptions> = {},
): PanelOptions {
  const log =
    <A extends unknown[], R>(name: string, answer: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return answer(...args);
    };
  return {
    stylesheets: { page: '/panel/page.css', panel: '/panel/panel.css', ui: '/ui/ui.css' },
    host: 'GitHub',
    onState: log('onState', () => undefined),
    onLayout: log('onLayout', () => undefined),
    onPosition: log('onPosition', () => undefined),
    onFilter: log('onFilter', () => undefined),
    onRead: log('onRead', () => undefined),
    reveal: log('reveal', () => undefined),
    reloadPage: log('reloadPage', () => undefined),
    ask: log('ask', async () => ({ ok: true })),
    loadQuestions: log('loadQuestions', async () => QUESTIONS),
    markQuestions: log(
      'markQuestions',
      async () => ({ questions: QUESTIONS, cleared: [] }) as never,
    ),
    status: log('status', async () => ({
      bridge: { version: '1.0.0' },
      story: { ok: true, id: 'story-1' },
      listening: {
        ok: false,
        prompt: '/once-upon-listen acme/widgets',
        repo: 'acme/widgets',
        checkout: '/work/widgets',
        start: 'once-upon wait --consumer once-upon',
        story_prompt: { prompt: '/once-upon-listen --story story-1' },
      },
    })),
    listen: {
      sessions: log('listen.sessions', async () => []),
      start: log('listen.start', async () => undefined),
    },
    drafts: {
      load: log('drafts.load', async () => DRAFTS),
      act: log('drafts.act', async () => DRAFTS),
    },
    fixes: {
      load: log('fixes.load', async () => FIXES),
      act: log('fixes.act', async () => FIXES),
      note: log('fixes.note', async () => ({})),
    },
    working: log('working', async () => ({ marks: WORKING })),
    freshness: log('freshness', async () => STALE),
    reads: log('reads', async () => READS),
    requestUpdate: log('requestUpdate', async () => ({})),
    requestRebuild: log('requestRebuild', async () => ({ rebuild: null })),
    pulse: log(
      'pulse',
      async () =>
        ({
          version: 'v1',
          questions_rev: '1',
          drafts_rev: '1',
          fixes_rev: '1',
          working_rev: '1',
          listening: false,
          answering: null,
          rebuild: {
            mode: 'rebuild',
            state: 'building',
            requested_at: '2026-11-03T11:00:00Z',
            claimed_by: 'author-1',
          },
          request: null,
        }) as never,
    ),
    ...overrides,
  };
}
