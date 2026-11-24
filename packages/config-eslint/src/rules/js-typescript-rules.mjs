// Ports of three typescript-eslint 8.71 recommended rules for JavaScript files.
// Oxlint runs its own `typescript/*` rules only on TypeScript sources, but
// ESLint with `tseslint.configs.recommended` ran these three on `.mjs` files
// too. Each port keeps the recommended default options and the original
// messages. TypeScript files keep Oxlint's native rules.

const segmenter = new Intl.Segmenter();
const graphemeLength = (text) => [...segmenter.segment(text)].length;
const LINEBREAK = /\r\n|[\r\n\u2028\u2029]/u;

// ban-ts-comment with: ts-expect-error allow-with-description, ts-ignore true,
// ts-nocheck true, ts-check false, minimumDescriptionLength 3.
const MINIMUM_DESCRIPTION_LENGTH = 3;
const singleLinePragma = /^\/\/\/?\s*@ts-(?<directive>check|nocheck)(?<description>.*)$/;
const directiveSingleLine = /^\/*\s*@ts-(?<directive>expect-error|ignore)(?<description>.*)/;
const directiveMultiLine = /^\s*(?:\/|\*)*\s*@ts-(?<directive>expect-error|ignore)(?<description>.*)/;

function findDirective(comment) {
  if (comment.type === 'Line') {
    return singleLinePragma.exec(`//${comment.value}`)?.groups ?? directiveSingleLine.exec(comment.value)?.groups ?? null;
  }
  const lines = comment.value.split(LINEBREAK);
  return directiveMultiLine.exec(lines[lines.length - 1])?.groups ?? null;
}

export const banTsComment = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow `@ts-<directive>` comments or require descriptions after directives (JavaScript files)' },
    messages: {
      tsDirectiveComment: 'Do not use "@ts-{{directive}}" because it alters compilation errors.',
      tsIgnoreInsteadOfExpectError: 'Use "@ts-expect-error" instead of "@ts-ignore", as "@ts-ignore" will do nothing if the following line is error-free.',
      tsDirectiveCommentRequiresDescription: 'Include a description after the "@ts-{{directive}}" directive to explain why the @ts-{{directive}} is necessary. The description must be {{minimumDescriptionLength}} characters or longer.'
    },
    schema: []
  },
  create(context) {
    return {
      Program(node) {
        const firstStatement = node.body[0];
        for (const comment of context.sourceCode.getAllComments()) {
          const match = findDirective(comment);
          if (!match) continue;
          const { directive, description } = match;
          if (directive === 'nocheck' && firstStatement && firstStatement.loc.start.line <= comment.loc.start.line) continue;
          if (directive === 'ignore') {
            context.report({ node: comment, messageId: 'tsIgnoreInsteadOfExpectError' });
          } else if (directive === 'nocheck') {
            context.report({ node: comment, messageId: 'tsDirectiveComment', data: { directive } });
          } else if (directive === 'expect-error' && graphemeLength(description.trim()) < MINIMUM_DESCRIPTION_LENGTH) {
            context.report({
              node: comment,
              messageId: 'tsDirectiveCommentRequiresDescription',
              data: { directive, minimumDescriptionLength: MINIMUM_DESCRIPTION_LENGTH }
            });
          }
        }
      }
    };
  }
};

// no-this-alias with: allowDestructuring true, allowedNames [].
export const noThisAlias = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow aliasing `this` (JavaScript files)' },
    messages: {
      thisAssignment: "Unexpected aliasing of 'this' to local variable.",
      thisDestructure: "Unexpected aliasing of members of 'this' to local variables."
    },
    schema: []
  },
  create(context) {
    const check = (id) => {
      if (id.type !== 'Identifier') return;
      context.report({ node: id, messageId: 'thisAssignment' });
    };
    return {
      VariableDeclarator(node) {
        if (node.init?.type === 'ThisExpression') check(node.id);
      },
      AssignmentExpression(node) {
        if (node.right.type === 'ThisExpression') check(node.left);
      }
    };
  }
};

// triple-slash-reference with: lib always, path never, types prefer-import.
const referencePattern = /^\/\s*<reference\s*(types|path|lib)\s*=\s*["|'](.*)["|']/;

export const tripleSlashReference = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow certain triple slash directives in favor of ES6-style import declarations (JavaScript files)' },
    messages: { tripleSlashReference: 'Do not use a triple slash reference for {{module}}, use `import` style instead.' },
    schema: []
  },
  create(context) {
    const typeReferences = [];
    return {
      Program(node) {
        // ESLint's `getCommentsBefore(Program)` is the comments before the first token.
        const firstToken = node.body[0]?.range[0] ?? Number.POSITIVE_INFINITY;
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.range[1] > firstToken) break;
          if (comment.type !== 'Line') continue;
          const result = referencePattern.exec(comment.value);
          if (!result) continue;
          if (result[1] === 'path') {
            context.report({ node: comment, messageId: 'tripleSlashReference', data: { module: result[2] } });
          } else if (result[1] === 'types') {
            typeReferences.push({ comment, importName: result[2] });
          }
        }
      },
      ImportDeclaration(node) {
        for (const reference of typeReferences) {
          if (reference.importName === node.source.value) {
            context.report({ node: reference.comment, messageId: 'tripleSlashReference', data: { module: reference.importName } });
          }
        }
      }
    };
  }
};
