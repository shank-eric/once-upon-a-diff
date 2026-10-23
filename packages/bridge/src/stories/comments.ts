// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/**
 * Drafted comments that come out of Q&A (by voice, chat or the Ask box) go
 * into the story's chapters.json, in the chapter's `comments`, so the panel
 * shows them under "Draft comments" on its next refresh. Nothing is posted
 * anywhere.
 *
 * A published PR story (~/.once-upon/<owner>-<repo>-<N>/) is a copy of
 * once-upon's scratch folder, which the next render copies over. So the
 * comment is written to both: the folder the bridge serves, and the
 * meta.json `source` folder when there is one.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.ts';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** @returns {{chapter, comment, added, files}} */
export function addComment(dir, meta, { chapter, path: rel, line, body }) {
  const step = Number(chapter);
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) {
    throw fail(400, 'the comment body is empty');
  }
  if (text.length > 20000) {
    throw fail(400, 'the comment body is too long');
  }
  const comment = {
    path: typeof rel === 'string' && rel.trim() ? rel.trim().slice(0, 1000) : '(general)',
    line: Number.isInteger(Number(line)) && Number(line) > 0 ? Number(line) : 0,
    body: text,
  };
  const targets = [path.join(dir, 'chapters.json')];
  const src = meta && meta.source ? path.join(meta.source, 'chapters.json') : null;
  if (src && existsSync(src) && path.resolve(src) !== path.resolve(targets[0])) {
    targets.push(src);
  }
  let added = false;
  const files = [];
  targets.forEach((file, i) => {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const target = Array.isArray(plan.chapters) ? plan.chapters[step - 1] : null;
    if (!Number.isInteger(step) || !target) {
      if (i === 0) {
        throw fail(400, `no chapter ${chapter} (the story has ${(plan.chapters || []).length})`);
      }
      return; // the source copy doesn't match; leave it alone
    }
    target.comments = Array.isArray(target.comments) ? target.comments : [];
    const dup = target.comments.some(
      (existing) =>
        existing.path === comment.path &&
        Number(existing.line || 0) === comment.line &&
        String(existing.body).trim() === comment.body,
    );
    if (!dup) {
      target.comments.push(comment);
      writeJsonAtomic(file, plan);
      if (i === 0) {
        added = true;
      }
    }
    files.push(file);
  });
  return { chapter: step, comment, added, files };
}
