import path from 'node:path';
import { writeJson } from './files.ts';

/**
 * A published story for acme/widgets#7 with two chapters (its pr.json too, so it also serves as a once-upon folder).
 * `meta` adds to or overrides its meta.json, such as the head_oid it was told from or its once-upon `source`.
 */
export function githubStory(
  dir: string,
  { meta = {} }: { meta?: Record<string, unknown> } = {},
): void {
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    pr_title: 'Add widgets',
    ...meta,
  });
  writeJson(path.join(dir, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Add widgets',
  });
  writeJson(path.join(dir, 'file-map.json'), {
    pr: 'acme/widgets#7',
    files: {
      'src/a.js': { chapters: [1, 2], partial_in: [1], finished_in: 2 },
      'src/b.js': { chapters: [2], partial_in: [], finished_in: 2 },
      'README.md': { chapters: [], partial_in: [], finished_in: null },
    },
  });
  writeJson(path.join(dir, 'chapters.json'), {
    title: 'Widgets',
    overview: 'Story map',
    refs: [],
    chapters: [
      {
        title: 'Chapter 1: Start',
        files: [{ rel: 'src/a.js', partial: true, note: 'the top' }],
        refs: [{ id: 'top', path: 'src/a.js', side: 'R', start: 1, end: 3, label: 'top' }],
        comments: [{ path: 'src/a.js', line: 2, body: 'Could you confirm?' }],
      },
      { title: 'Chapter 2: Finish', files: ['src/a.js', 'src/b.js'], refs: [] },
    ],
  });
}
