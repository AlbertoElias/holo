import { findTokenColours, loadTokenColours, tokenForHexNumber } from '../token-literals.mjs';

const message = (text, token) => `${text} copies the design token ${token}; read it from @holoim/design-tokens instead.`;

/** Fails on a string, template or hex-number literal equal to a token colour outside the token package. */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hand-copied design-token colours' },
    schema: []
  },
  create(context) {
    const filename = context.filename.split('\\').join('/');
    if (filename.includes('/packages/design-tokens/')) return {};
    const colours = loadTokenColours();
    const checkText = (node, text) => {
      for (const hit of findTokenColours(text, colours)) context.report({ node, message: message(hit.text, hit.token) });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
        else if (typeof node.value === 'number') {
          const token = tokenForHexNumber(node.raw, colours);
          if (token) context.report({ node, message: message(node.raw, token) });
        }
      },
      TemplateElement(node) {
        checkText(node, node.value.raw);
      }
    };
  }
};
