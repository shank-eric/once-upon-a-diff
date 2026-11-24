/*
 * The conditions in a file that spell out a rule the repo already names. A candidate is every comparison, negation, `.includes`
 * style call, and every contiguous run of two or more operands of an `&&` or `||` chain; each is normalized once per value it
 * could be about (`$0`) and looked up in the index. Only conditions touching the added lines count when a diff is given.
 */
import typescript from 'typescript';
import { chainsIn, groupText, normalize, operandsOf } from './normalize.ts';
import { canCall, placeOf } from './layers.ts';
import { touches } from './diff.ts';
import type { Index, Predicate } from './predicates.ts';

type Node = typescript.Node;
const Kind = typescript.SyntaxKind;

export interface Hit {
  file: string;
  line: number;
  text: string;
  predicate: string;
  definedAt: string;
  /** the condition is the rule's opposite: call `!predicate(...)` */
  negated: boolean;
  /** a lone comparison matched: advice of lower weight */
  note: boolean;
}

const MAX_CHAIN = 8;
const BOOLEAN_CALLS = new Set(['includes', 'some', 'every', 'has']);

function isCandidateNode(node: Node): boolean {
  if (typescript.isBinaryExpression(node)) {
    return [
      Kind.EqualsEqualsEqualsToken,
      Kind.ExclamationEqualsEqualsToken,
      Kind.AmpersandAmpersandToken,
      Kind.BarBarToken,
    ].includes(node.operatorToken.kind);
  }
  if (typescript.isPrefixUnaryExpression(node)) {
    return node.operator === Kind.ExclamationToken;
  }
  return (
    typescript.isCallExpression(node) &&
    typescript.isPropertyAccessExpression(node.expression) &&
    BOOLEAN_CALLS.has(node.expression.name.text)
  );
}

/** The runs of 2+ operands of a chain whose head is `node` (the whole chain included); none when `node` is not a head. */
function windowsOf(node: Node): Array<{ operands: Node[]; operator: '&&' | '||' }> {
  const operands = operandsOf(node);
  if (!operands || !typescript.isBinaryExpression(node) || operands.length > MAX_CHAIN) {
    return [];
  }
  const kind = node.operatorToken.kind;
  const parent = unwrapUp(node);
  if (parent && typescript.isBinaryExpression(parent) && parent.operatorToken.kind === kind) {
    return [];
  }
  const operator = kind === Kind.BarBarToken ? '||' : '&&';
  const runs: Array<{ operands: Node[]; operator: '&&' | '||' }> = [];
  for (let from = 0; from < operands.length; from++) {
    for (let last = from + 2; last <= operands.length; last++) {
      runs.push({ operands: operands.slice(from, last), operator });
    }
  }
  return runs;
}

/** The parent past any parentheses around `node`. */
function unwrapUp(node: Node): Node | undefined {
  let parent = node.parent;
  while (parent && typescript.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  return parent;
}

/** The key of the opposite condition: `!(x)` is `x`'s, and anything else is negated by wrapping it. */
const opposite = (key: string): string =>
  key.startsWith('!(') && key.endsWith(')') ? key.slice(2, -1) : `!(${key})`;

/**
 * Where a condition's hit ends for dedupe: a lone node, or a run that is the whole chain `anchor` heads, ends where the `!` and
 * parentheses around it end, so `!(a && b)` is one hit, not one for the chain and one for its negation.
 */
function outerEnd(nodes: Node[], anchor: Node): number {
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const whole =
    nodes.length === 1 ||
    (first.getStart() === anchor.getStart() && last.getEnd() === anchor.getEnd());
  let outer: Node = nodes.length === 1 ? first : anchor;
  if (!whole) {
    return last.getEnd();
  }
  for (let parent = outer.parent; parent; parent = outer.parent) {
    const wraps =
      typescript.isParenthesizedExpression(parent) ||
      (typescript.isPrefixUnaryExpression(parent) && parent.operator === Kind.ExclamationToken);
    if (!wraps) {
      break;
    }
    outer = parent;
  }
  return outer.getEnd();
}

const squash = (text: string): string => {
  const one = text.replace(/\s+/g, ' ');
  return one.length > 90 ? `${one.slice(0, 87)}...` : one;
};

/** The hits for one file. `ranges` limits them to conditions touching those added lines; null means the whole file. */
export function findHits(
  file: string,
  text: string,
  index: Index,
  ranges: Array<[number, number]> | null,
): Hit[] {
  const place = placeOf(file);
  if (!place) {
    return [];
  }
  const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true);
  const hits = new Map<string, Hit>();
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

  const check = (nodes: Node[], read: (subject: string) => string, anchor: Node): void => {
    const start = nodes[0]!.getStart();
    const end = nodes[nodes.length - 1]!.getEnd();
    if (ranges && !touches(ranges, lineOf(start), lineOf(end))) {
      return;
    }
    const subjects = new Set(nodes.flatMap((node) => chainsIn(node)));
    for (const subject of subjects) {
      const key = read(subject);
      const fair = (one: Predicate): boolean => usable(one, file, start, end);
      const exact = index.get(key)?.find(fair);
      const rule = exact ?? index.get(opposite(key))?.find(fair);
      if (!rule) {
        continue;
      }
      const negated = exact === undefined;
      const id = `${rule.name}:${outerEnd(nodes, anchor)}`;
      if (hits.has(id)) {
        continue; // the outer condition is visited first: it reads the `!` the inner one lacks
      }
      hits.set(id, {
        file,
        line: lineOf(start),
        text: squash(source.text.slice(start, end)),
        predicate: rule.name,
        definedAt: `${rule.file}:${rule.line}`,
        negated,
        note: rule.note,
      });
    }
  };

  const visit = (node: Node): void => {
    if (isCandidateNode(node)) {
      check([node], (subject) => normalize(node, subject), node);
      for (const { operands, operator } of windowsOf(node)) {
        check(operands, (subject) => groupText(operands, operator, subject), node);
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
  return [...hits.values()];
}

/** A rule is a fair match when it is not the condition's own definition and the layers let the file call it. */
function usable(rule: Predicate, file: string, start: number, end: number): boolean {
  const here = placeOf(file);
  if (rule.file === file && start >= rule.start && end <= rule.end) {
    return false;
  }
  return here !== null && canCall(rule.place, here);
}
