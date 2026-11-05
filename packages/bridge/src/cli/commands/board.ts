/*
 * The agent board: `once-upon board` prints (and opens) the board page's link, with its key, and says what is running.
 * The page itself is public/board.ts; its data is services/board/board.ts.
 */
import { openTarget } from '../../services/config/settings.ts';
import { pageOrigin } from '../../services/pages/address.ts';
import { boardPageUrl } from '../../services/pages/page-key.ts';
import { Board, noPrWatcher } from '../../services/board/board.ts';
import { StoryStore } from '../../services/stories/store.ts';
import { Builds } from '../../services/inbox/builds.ts';
import { plural } from '@once-upon-a-diff/domain/text';
import { out } from '../output.ts';
import type { Config } from '../../services/config/settings.ts';
import type { CliOpts, Command } from '../types.ts';

/** `once-upon board [--local] [--no-open]`: the agent board page's link, on the proxy's name (`--local`: 127.0.0.1). */
async function board(home: string, cfg: Config, opts: CliOpts) {
  const cards = (
    await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home)).snapshot()
  ).lanes.flatMap((lane) => lane.cards);
  const count = (column: string) => cards.filter((card) => card.column === column).length;
  process.stderr.write(
    `${plural(cards.length, 'card')}: ${count('working')} working, ${count('waiting')} waiting, ${count('ready')} ready for review${count('research') ? `, ${count('research')} research` : ''}\n`,
  );
  const url = boardPageUrl(
    Number(opts.port || cfg.port),
    cfg.token,
    await pageOrigin(home, Number(opts.port || cfg.port), !!opts.local),
  );
  out(url);
  if (!opts['no-open']) {
    openTarget(url, home);
  }
}

export const boardCommands: Command[] = [
  {
    name: 'board',
    usage: [
      '  once-upon board   [--local] [--no-open]                        the agent board page: your work to merge, and the sessions and agents on it',
    ],
    run: board,
  },
];
