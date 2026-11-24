/*
 * The index of rules the repo already names: every exported one-parameter function whose body is a single boolean expression
 * (`export const isListed = (item) => ...`, or a function holding one `return`), keyed by its normalized body.
 */
import typescript from 'typescript';
import { chainText, normalize, unwrap } from './normalize.ts';
import { INDEXED, placeOf, type Place } from './layers.ts';

type Node = typescript.Node;
const Kind = typescript.SyntaxKind;

export interface Predicate {
  name: string;
  file: string;
  line: number;
  place: Place;
  /** the declaration's span, so a match inside the predicate itself is skipped */
  start: number;
  end: number;
  /** a lone comparison (`$0.kind === 'critic'`): reported as a note, since its half is often a different rule */
  note: boolean;
}

export type Index = Map<string, Predicate[]>;

const BOOLEAN_NAME = /^(is|has|can|should)[A-Z]/;
const BOOLEAN_CALLS = new Set(['includes', 'some', 'every', 'has']);

const isLiteral = (node: Node): boolean => {
  const inner = unwrap(node);
  return (
    typescript.isStringLiteralLike(inner) ||
    typescript.isNumericLiteral(inner) ||
    inner.kind === Kind.TrueKeyword ||
    inner.kind === Kind.FalseKeyword ||
    inner.kind === Kind.NullKeyword
  );
};

/** A lone `a.b === 'x'` (or `!==`, or negated): both sides a plain chain or a literal. */
function isSingleComparison(node: Node): boolean {
  let inner = unwrap(node);
  while (typescript.isPrefixUnaryExpression(inner) && inner.operator === Kind.ExclamationToken) {
    inner = unwrap(inner.operand);
  }
  if (!typescript.isBinaryExpression(inner)) {
    return false;
  }
  const kind = inner.operatorToken.kind;
  if (kind !== Kind.EqualsEqualsEqualsToken && kind !== Kind.ExclamationEqualsEqualsToken) {
    return false;
  }
  const plain = (side: Node): boolean => chainText(side) !== null || isLiteral(side);
  return plain(inner.left) && plain(inner.right);
}

/** `x.y` or `!x.y`: a property read, too small to be a rule of its own. */
function isBareRead(node: Node): boolean {
  let inner = unwrap(node);
  while (typescript.isPrefixUnaryExpression(inner) && inner.operator === Kind.ExclamationToken) {
    inner = unwrap(inner.operand);
  }
  return chainText(inner) !== null;
}

function isBooleanShape(node: Node): boolean {
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

/** The one expression a function returns, or null. */
function singleExpression(func: typescript.FunctionLikeDeclaration): Node | null {
  const body = func.body;
  if (!body) {
    return null;
  }
  if (!typescript.isBlock(body)) {
    return body;
  }
  const [only] = body.statements;
  return body.statements.length === 1 && only && typescript.isReturnStatement(only)
    ? (only.expression ?? null)
    : null;
}

interface Declared {
  name: string;
  func: typescript.FunctionLikeDeclaration;
  whole: Node;
}

const isExported = (statement: typescript.Statement): boolean =>
  !!typescript
    .getModifiers(statement as typescript.HasModifiers)
    ?.some((modifier) => modifier.kind === Kind.ExportKeyword);

/** The functions a statement exports by name: `export function f`, or `export const f = () => ...`. */
function exportedFunctions(statement: typescript.Statement): Declared[] {
  if (typescript.isFunctionDeclaration(statement) && statement.name) {
    return [{ name: statement.name.text, func: statement, whole: statement }];
  }
  if (!typescript.isVariableStatement(statement)) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) => {
    const init = declaration.initializer && unwrap(declaration.initializer);
    const isFunction =
      init && (typescript.isArrowFunction(init) || typescript.isFunctionExpression(init));
    return isFunction && typescript.isIdentifier(declaration.name)
      ? [{ name: declaration.name.text, func: init, whole: statement }]
      : [];
  });
}

/** The body of a function that takes one plain parameter and is a boolean rule written as one expression: the body and the parameter's name. */
function ruleBody({ name, func }: Declared): { body: Node; param: string } | null {
  const [param] = func.parameters;
  const expression = singleExpression(func);
  if (
    func.parameters.length !== 1 ||
    !param ||
    !typescript.isIdentifier(param.name) ||
    !expression
  ) {
    return null;
  }
  const body = unwrap(expression);
  // a call to a named function is a wrapper (`isFinished = isEndState(agent.state)`), not a rule written out
  const wrapper = typescript.isCallExpression(body) && typescript.isIdentifier(body.expression);
  const rule = isBooleanShape(body) || (BOOLEAN_NAME.test(name) && !chainText(body));
  return wrapper || !rule || isBareRead(body) ? null : { body, param: param.name.text };
}

/** The rules a file defines, keyed by normalized body. */
export function indexSource(file: string, text: string, into: Index = new Map()): Index {
  const place = placeOf(file);
  if (!place || !INDEXED.includes(place.name)) {
    return into;
  }
  const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true);
  const declared = source.statements.filter(isExported).flatMap(exportedFunctions);
  for (const one of declared) {
    const rule = ruleBody(one);
    const key = rule && normalize(rule.body, rule.param);
    if (!rule || !key?.includes('$0')) {
      continue;
    }
    const entry: Predicate = {
      name: one.name,
      file,
      line: source.getLineAndCharacterOfPosition(one.whole.getStart()).line + 1,
      place,
      start: one.whole.getStart(),
      end: one.whole.getEnd(),
      note: isSingleComparison(rule.body),
    };
    into.set(key, [...(into.get(key) ?? []), entry]);
  }
  return into;
}
