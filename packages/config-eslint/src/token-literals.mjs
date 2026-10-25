// Finds hand-copied design-token colours: '#ffc872', '#FFC872cc', 0xffc872,
// rgb(255, 200, 114), rgba(8,26,30,.72), rgb(8 26 30 / 50%). Shared by the
// ESLint rule and the CSS check, so both read the same generated token file.
import { readFileSync } from 'node:fs';

const tokenFile = new URL('../../design-tokens/src/generated/tokens.json', import.meta.url);

/** Token name for each token colour, keyed by lower-case `#rrggbb`. */
export function loadTokenColours(file = tokenFile) {
  const flat = JSON.parse(readFileSync(file, 'utf8'));
  const colours = new Map();
  for (const [name, value] of Object.entries(flat)) {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value) && !colours.has(value)) colours.set(value, name);
  }
  return colours;
}

const COLOUR_PATTERN = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])|\brgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/gi;

const byte = (value) => Number(value).toString(16).padStart(2, '0');

/** Each token colour written in `text`, with its offset. */
export function findTokenColours(text, colours) {
  const found = [];
  for (const match of text.matchAll(COLOUR_PATTERN)) {
    let hex;
    if (match[1]) {
      const digits = match[1].toLowerCase();
      hex = digits.length <= 4 ? [...digits.slice(0, 3)].map((digit) => digit + digit).join('') : digits.slice(0, 6);
    } else {
      hex = byte(match[2]) + byte(match[3]) + byte(match[4]);
    }
    const name = colours.get(`#${hex}`);
    if (name) found.push({ index: match.index, text: match[0], token: name });
  }
  return found;
}

/** The token colour a numeric literal such as `0xffc872` copies, if any. */
export function tokenForHexNumber(raw, colours) {
  if (!/^0x[0-9a-f]{6}$/i.test(raw)) return undefined;
  return colours.get(`#${raw.slice(2).toLowerCase()}`);
}
