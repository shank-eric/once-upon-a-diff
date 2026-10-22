/*
 * What only a local story keeps on the bridge: Viewed per file (GitHub keeps it for PR stories). Fix-before-push
 * notes are in ./fixes.mjs, for PR and local stories alike.
 */
import { HttpError } from '../request.mjs';

function viewed({ app, body, send }, story) {
  if (story.meta.kind !== 'local') {
    throw new HttpError(400, 'viewed files are kept by GitHub for PR stories');
  }
  const data = app.stories.load(story.id);
  const file = data.local.files.find((candidate) => candidate.rel === body.path);
  if (!file) {
    throw new HttpError(404, 'that file is not in the diff');
  }
  const viewedFiles = app.stories.readState(story.id, 'viewed.json', {});
  if (body.viewed) {
    viewedFiles[file.rel] = { hash: file.hash, at: new Date().toISOString() };
  } else {
    delete viewedFiles[file.rel];
  }
  app.stories.writeState(story.id, 'viewed.json', viewedFiles);
  return send(200, { path: file.rel, viewed: !!body.viewed });
}

export const localStoryRoutes = [{ what: 'viewed', method: 'POST', handle: viewed }];
