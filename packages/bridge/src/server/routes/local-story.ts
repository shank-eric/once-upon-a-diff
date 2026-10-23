/*
 * What only a local story keeps on the bridge: Viewed per file (GitHub keeps it for PR stories). Fix-before-push
 * notes are in ./fixes.ts, for PR and local stories alike.
 */
import { HttpError } from '../request.ts';
import type { LocalStory, StoryData } from '@once-upon-a-diff/shared/types';
import type { Call, ServedStory, StoryRoute } from '../../types.ts';

function viewed({ app, body, send }: Call, story: ServedStory) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, 'viewed files are kept by GitHub for PR stories');
  }
  const data = app.stories.load(story.id) as StoryData & { local: LocalStory };
  const file = data.local.files.find((candidate) => candidate.rel === body.path);
  if (!file) {
    throw new HttpError(404, 'that file is not in the diff');
  }
  const viewedFiles = app.stories.readState<Record<string, { hash?: string | null; at: string }>>(
    story.id,
    'viewed.json',
    {},
  ) as Record<string, { hash?: string | null; at: string }>;
  if (body.viewed) {
    viewedFiles[file.rel] = { hash: file.hash, at: new Date().toISOString() };
  } else {
    delete viewedFiles[file.rel];
  }
  app.stories.writeState(story.id, 'viewed.json', viewedFiles);
  return send(200, { path: file.rel, viewed: !!body.viewed });
}

export const localStoryRoutes: StoryRoute[] = [{ what: 'viewed', method: 'POST', handle: viewed }];
