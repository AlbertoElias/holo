import tokens from '@holoim/design-tokens/tokens.json' with { type: 'json' };

// The design system's colors (docs/product/design/tokens.json) under short
// names, as sRGB hex. Scene-specific paint (walnut, moss, a quilt) stays a
// literal in its scene; anything that is a token comes from here.

const color = (key) => {
  const value = tokens[`color.${key}`];
  if (typeof value !== 'string') throw new Error(`design token color.${key} is missing`);
  return value;
};

export const T = {
  groundTop: color('ground.top'),
  groundMid: color('ground.mid'),
  groundGrey: color('ground.grey'),
  horizon: color('ground.horizon'),
  deepSea: color('deepSea'),
  text: color('text'),
  textMuted: color('textMuted'),
  gold: color('gold'),
  glow: color('glow'),
  highlight: color('highlight'),
  record: color('record'),
  identity: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => color(`identity.${n}`))
};
