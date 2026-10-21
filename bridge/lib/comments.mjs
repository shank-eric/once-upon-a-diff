/**
 * Drafted comments that come out of Q&A (by voice, chat or the Ask box) go
 * into the story's chapters.json, in the chapter's `comments`, so the panel
 * shows them under "Draft comments" on its next refresh. Nothing is posted
 * anywhere.
 *
 * A published PR story (~/.diff-story/<owner>-<repo>-<N>/) is a copy of
 * pr-story's scratch folder, which the next render copies over. So the
 * comment is written to both: the folder the bridge serves, and the
 * meta.json `source` folder when there is one.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** @returns {{chapter, comment, added, files}} */
export function addComment(dir, meta, { chapter, path: rel, line, body }) {
  const n = Number(chapter);
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
    const ch = Array.isArray(plan.chapters) ? plan.chapters[n - 1] : null;
    if (!Number.isInteger(n) || !ch) {
      if (i === 0) {
        throw fail(400, `no chapter ${chapter} (the story has ${(plan.chapters || []).length})`);
      }
      return; // the source copy doesn't match; leave it alone
    }
    ch.comments = Array.isArray(ch.comments) ? ch.comments : [];
    const dup = ch.comments.some(
      (c) =>
        c.path === comment.path &&
        Number(c.line || 0) === comment.line &&
        String(c.body).trim() === comment.body,
    );
    if (!dup) {
      ch.comments.push(comment);
      writeJsonAtomic(file, plan);
      if (i === 0) {
        added = true;
      }
    }
    files.push(file);
  });
  return { chapter: n, comment, added, files };
}
