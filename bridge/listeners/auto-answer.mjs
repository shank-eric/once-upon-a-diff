/**
 * Answering questions without a Claude session listening.
 *
 * autoAnswer (off unless config.json turns it on) runs a command for each new
 * question. It's an argv array, never run through a shell. {question},
 * {context}, {story} and {id} in its arguments are replaced. {context} is a
 * JSON file with the story's overview, the asked-about chapter's narrative
 * and files, and that chapter's diff when the bridge has one. Whatever the
 * command prints to stdout, if it exits 0, becomes the answer:
 *   "autoAnswer": {"enabled": true, "command": ["claude", "-p", "Answer this review question using {context}: {question}"]}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff } from '../util/diff.mjs';

/** The context file auto-answer hands its command: the story and the asked-about chapter, with its diff when there is one. */
export function answerContext(storyData, storyDir, question) {
  const step = Number(question.step) || 0;
  const chapter = step > 0 ? storyData.chapters[step - 1] : null;
  const rels = new Set((chapter ? chapter.files : storyData.files).map((file) => file.rel));
  let diff = null;
  for (const name of ['local.diff', 'pr.diff']) {
    const file = storyDir && path.join(storyDir, name);
    if (file && existsSync(file)) {
      const parsed = parseUnifiedDiff(readFileSync(file, 'utf8'));
      diff = [...parsed.values()]
        .filter((file) => rels.has(file.rel))
        .map((file) => ({
          rel: file.rel,
          hunks: file.hunks.map((hunk) => ({
            at: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            lines: hunk.lines,
          })),
        }));
      break;
    }
  }
  return {
    question: {
      id: question.id,
      text: question.text,
      file: question.file || null,
      step: step,
      chapter: question.chapter || null,
    },
    story: {
      id: storyData.id,
      kind: storyData.kind,
      title: storyData.title,
      pr: storyData.pr,
      overview: storyData.overview || storyData.summary || '',
    },
    chapter: chapter
      ? {
          title: chapter.title,
          narrative: chapter.narrative,
          files: chapter.files,
          comments: chapter.comments,
        }
      : null,
    diff,
  };
}

/** autoAnswer: run the configured command for one question; stdout (exit 0) becomes the answer. */
export function runAutoAnswer({ home, autoAnswer, question, context, onAnswer, onFail }) {
  const cmd = autoAnswer && autoAnswer.command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((arg) => typeof arg === 'string')) {
    onFail('autoAnswer.command must be an array of strings');
    return;
  }
  const dir = path.join(home, 'answers');
  mkdirSync(dir, { recursive: true });
  const ctxFile = path.join(dir, `${question.id}.context.json`);
  writeFileSync(ctxFile, JSON.stringify(context, null, 2));
  const fill = (arg) =>
    arg
      .replace(/\{question\}/g, question.text)
      .replace(/\{context\}/g, ctxFile)
      .replace(/\{story\}/g, question.story)
      .replace(/\{id\}/g, question.id);
  const cwd = autoAnswer.cwd ? autoAnswer.cwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1).map(fill), {
      cwd: existsSync(cwd) ? cwd : os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DIFF_STORY_QUESTION_ID: question.id,
        DIFF_STORY_CONTEXT: ctxFile,
        DIFF_STORY_STORY: question.story,
      },
    });
  } catch (e) {
    onFail(`autoAnswer could not start: ${e.message}`);
    return;
  }
  const timeout = setTimeout(() => child.kill('SIGTERM'), (autoAnswer.timeout_s || 600) * 1000);
  child.stdout.on('data', (chunk) => {
    if (stdout.length < 100000) {
      stdout += chunk;
    }
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 20000) {
      stderr += chunk;
    }
  });
  child.on('error', (e) => {
    clearTimeout(timeout);
    onFail(`autoAnswer could not start: ${e.message}`);
  });
  child.on('exit', (code) => {
    clearTimeout(timeout);
    writeFileSync(
      path.join(dir, `${question.id}.log`),
      `exit ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
    );
    if (code === 0 && stdout.trim()) {
      onAnswer(stdout.trim());
    } else {
      onFail(`autoAnswer exited ${code}`);
    }
  });
}
