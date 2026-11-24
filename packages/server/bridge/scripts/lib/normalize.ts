/*
 * The expression normalizer behind restated-rules: it prints a boolean expression in one canonical form so two spellings of the
 * same condition give the same string. Only structural equality, never semantics: `a ?? 'x'` and `a || 'x'` stay different.
 * What it folds: parentheses, `as` casts, non-null `!`, `?.` against `.`, quote style, `!!x` to `x`, `a !== b` to `!(a === b)`,
 * the order of `&&`/`||` operands and of the two sides of `===`, and the name of the one value a rule is about (written `$0`).
 */
import typescript from 'typescript';

type Node = typescript.Node;
const Kind = typescript.SyntaxKind;

/** Strips what never changes the condition: parentheses, casts, non-null `!`, `satisfies`. */
export function unwrap(node: Node): Node {
  let current = node;
  while (
    typescript.isParenthesizedExpression(current) ||
    typescript.isAsExpression(current) ||
    typescript.isNonNullExpression(current) ||
    typescript.isSatisfiesExpression(current) ||
    typescript.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The dotted text of a plain property chain (`agent.state`, `item`), or null for anything with a call or a computed part. */
export function chainText(node: Node): string | null {
  const inner = unwrap(node);
  if (typescript.isIdentifier(inner)) {
    return inner.text;
  }
  if (typescript.isPropertyAccessExpression(inner)) {
    const base = chainText(inner.expression);
    return base === null ? null : `${base}.${inner.name.text}`;
  }
  return null;
}

/** Every plain chain inside a node, longest first (`a.b.c` before `a.b`): what `$0` may stand for. */
export function chainsIn(node: Node): string[] {
  const found = new Set<string>();
  const visit = (one: Node): void => {
    if (typescript.isPropertyAccessExpression(one) || typescript.isIdentifier(one)) {
      const text = chainText(one);
      if (text !== null && !isDeclaredName(one)) {
        let current: string | undefined = text;
        while (current) {
          found.add(current);
          current = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : undefined;
        }
      }
    }
    typescript.forEachChild(one, visit);
  };
  visit(node);
  return [...found];
}

/** A property name on the right of a dot is not a value of its own. */
function isDeclaredName(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined && typescript.isPropertyAccessExpression(parent) && parent.name === node
  );
}

function flatten(node: Node, operator: typescript.SyntaxKind, out: Node[]): void {
  const inner = unwrap(node);
  if (typescript.isBinaryExpression(inner) && inner.operatorToken.kind === operator) {
    flatten(inner.left, operator, out);
    flatten(inner.right, operator, out);
    return;
  }
  out.push(inner);
}

/** The operands of a same-operator `&&` or `||` chain, flattened (`a && (b && c)` is three). */
export function operandsOf(node: Node): Node[] | null {
  const inner = unwrap(node);
  if (!typescript.isBinaryExpression(inner)) {
    return null;
  }
  const kind = inner.operatorToken.kind;
  if (kind !== Kind.AmpersandAmpersandToken && kind !== Kind.BarBarToken) {
    return null;
  }
  const out: Node[] = [];
  flatten(inner, kind, out);
  return out;
}

const COMMUTES = new Set([
  Kind.AmpersandAmpersandToken,
  Kind.BarBarToken,
  Kind.EqualsEqualsEqualsToken,
]);

/** The canonical text of an expression, with the chain `subject` (a name or `a.b`) written `$0`. */
export function normalize(node: Node, subject: string): string {
  const inner = unwrap(node);
  const text = (one: Node): string => normalize(one, subject);

  const chain = chainText(inner);
  if (chain !== null) {
    return chain === subject ? '$0' : replaceRoot(chain, subject);
  }
  if (typescript.isPropertyAccessExpression(inner)) {
    return `${text(inner.expression)}.${inner.name.text}`;
  }
  if (typescript.isElementAccessExpression(inner)) {
    return `${text(inner.expression)}[${text(inner.argumentExpression)}]`;
  }
  if (typescript.isStringLiteralLike(inner)) {
    return JSON.stringify(inner.text);
  }
  if (typescript.isPrefixUnaryExpression(inner)) {
    return normalizePrefix(inner, subject);
  }
  if (typescript.isBinaryExpression(inner)) {
    return normalizeBinary(inner, subject);
  }
  if (typescript.isCallExpression(inner)) {
    return `${text(inner.expression)}(${inner.arguments.map(text).join(',')})`;
  }
  if (typescript.isConditionalExpression(inner)) {
    return `(${text(inner.condition)}?${text(inner.whenTrue)}:${text(inner.whenFalse)})`;
  }
  if (typescript.isArrowFunction(inner) || typescript.isFunctionExpression(inner)) {
    return `fn(${inner.getText()})`;
  }
  return inner.getText().replace(/\s+/g, ' ');
}

/** `agent.state` with the subject `agent` swapped to `$0`: a chain that starts at the subject keeps its tail. */
function replaceRoot(chain: string, subject: string): string {
  return chain.startsWith(`${subject}.`) ? `$0${chain.slice(subject.length)}` : chain;
}

function normalizePrefix(node: typescript.PrefixUnaryExpression, subject: string): string {
  if (node.operator !== Kind.ExclamationToken) {
    return node.getText().replace(/\s+/g, ' ');
  }
  const operand = unwrap(node.operand);
  if (typescript.isPrefixUnaryExpression(operand) && operand.operator === Kind.ExclamationToken) {
    // `!!x` reads as `x` where a condition is wanted
    return normalize(operand.operand, subject);
  }
  return `!(${normalize(operand, subject)})`;
}

function normalizeBinary(node: typescript.BinaryExpression, subject: string): string {
  const kind = node.operatorToken.kind;
  if (kind === Kind.ExclamationEqualsEqualsToken) {
    return `!(${sides(node, subject, '===')})`;
  }
  if (kind === Kind.AmpersandAmpersandToken || kind === Kind.BarBarToken) {
    const operator = kind === Kind.AmpersandAmpersandToken ? '&&' : '||';
    const operands = operandsOf(node) ?? [node];
    return groupText(operands, operator, subject);
  }
  const operator = node.operatorToken.getText();
  return COMMUTES.has(kind)
    ? sides(node, subject, operator)
    : `(${normalize(node.left, subject)}${operator}${normalize(node.right, subject)})`;
}

/** The canonical text of operands joined by one `&&` or `||` (any order): also what a contiguous part of a longer chain is read as. */
export function groupText(operands: Node[], operator: '&&' | '||', subject: string): string {
  return `(${operands
    .map((one) => normalize(one, subject))
    .sort()
    .join(operator)})`;
}

function sides(node: typescript.BinaryExpression, subject: string, operator: string): string {
  const both = [normalize(node.left, subject), normalize(node.right, subject)].sort();
  return `(${both[0]}${operator}${both[1]})`;
}
