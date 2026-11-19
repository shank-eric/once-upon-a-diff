/*
 * Long guard chains (a readability measure, a warning like the sonarjs ones in eslint.config.mjs): an `if` whose test chains
 * more than `max` operands with `||` / `&&` (an early exit like `if (!a || !b || !c || !d || !e) continue;`) hides what the
 * guard asks. Name the positive check (`const eligible = ...`, or a predicate function) and exit on `!eligible`.
 * Mixed chains count every leaf operand, parenthesized groups included. Operands that are not a `!x` or `!==` count as plain.
 */

const operandsOf = (node) =>
  node.type === 'LogicalExpression'
    ? [...operandsOf(node.left), ...operandsOf(node.right)]
    : [node];

export const guards = {
  rules: {
    'long-guard': {
      meta: {
        type: 'suggestion',
        schema: [
          { type: 'object', properties: { max: { type: 'integer' } }, additionalProperties: false },
        ],
        messages: {
          long: 'This guard chains {{count}} operands (max {{max}}): name the positive check and exit on its negation.',
        },
      },
      create(context) {
        const max = context.options[0]?.max ?? 4;
        return {
          IfStatement(node) {
            if (node.test.type !== 'LogicalExpression') {
              return;
            }
            const count = operandsOf(node.test).length;
            if (count > max) {
              context.report({ node: node.test, messageId: 'long', data: { count, max } });
            }
          },
        };
      },
    },
  },
};
