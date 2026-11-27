import { banTsComment, noThisAlias, tripleSlashReference } from './rules/js-typescript-rules.mjs';
import noTokenColourLiteral from './rules/no-token-colour-literal.mjs';

// Oxlint JS plugin: the design-token rule, and the typescript-eslint rules that
// Oxlint runs only on TypeScript sources, for JavaScript files.
export default {
  meta: { name: 'holoim' },
  rules: {
    'no-token-colour-literal': noTokenColourLiteral,
    'js-ban-ts-comment': banTsComment,
    'js-no-this-alias': noThisAlias,
    'js-triple-slash-reference': tripleSlashReference
  }
};
