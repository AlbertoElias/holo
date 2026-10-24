// Generates src/generated/tokens.{ts,css,json} from the W3C DTCG token file
// docs/product/design/tokens.json, which stays beside the styleguide.
// Usage: tsx scripts/generate.ts          write the outputs
//        tsx scripts/generate.ts --check  fail if the committed outputs differ
// Only tokens with a $value are generated; $description, $extensions and
// free text never reach code, so an undecided item has no value to read.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN_FILE = path.resolve(packageDir, '../../docs/product/design/tokens.json');
export const OUTPUT_DIR = path.join(packageDir, 'src/generated');

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface Token {
  path: string[];
  type: string;
  value: Json;
}

export class TokenError extends Error {}

const ALIAS = /^\{([^{}]+)\}$/;
const REM_PX = 16;

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every token with a $value, in file order, with group $type inherited. */
export function collectTokens(root: JsonObject): Token[] {
  const tokens: Token[] = [];
  const walk = (node: JsonObject, at: string[], inheritedType: string | undefined) => {
    const groupType = typeof node.$type === 'string' ? node.$type : inheritedType;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isObject(child)) continue;
      if ('$value' in child) {
        const type = typeof child.$type === 'string' ? child.$type : groupType;
        if (!type) throw new TokenError(`${[...at, key].join('.')} has no $type`);
        tokens.push({ path: [...at, key], type, value: child.$value! });
      } else {
        walk(child, [...at, key], groupType);
      }
    }
  };
  walk(root, [], undefined);
  return tokens;
}

/** Replaces every "{a.b}" alias, at any depth, with the referenced token's resolved value. */
export function resolveAliases(tokens: Token[]): Token[] {
  const byName = new Map(tokens.map((token) => [token.path.join('.'), token]));
  const resolved = new Map<string, Json>();
  const resolveToken = (name: string, chain: string[]): Json => {
    if (resolved.has(name)) return resolved.get(name)!;
    if (chain.includes(name)) throw new TokenError(`circular alias: ${[...chain, name].join(' -> ')}`);
    const token = byName.get(name);
    if (!token) throw new TokenError(`unresolved alias {${name}} in ${chain.at(-1)}`);
    const value = resolveValue(token.value, [...chain, name]);
    resolved.set(name, value);
    return value;
  };
  const resolveValue = (value: Json, chain: string[]): Json => {
    if (typeof value === 'string') {
      const alias = ALIAS.exec(value);
      return alias ? resolveToken(alias[1]!, chain) : value;
    }
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, chain));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, chain)]));
    return value;
  };
  return tokens.map((token) => ({ ...token, value: resolveToken(token.path.join('.'), []) }));
}

function fail(token: Token, message: string): never {
  throw new TokenError(`${token.path.join('.')} (${token.type}): ${message}`);
}

function hexOf(token: Token, value: Json): string {
  if (!isObject(value) || value.colorSpace !== 'srgb' || !Array.isArray(value.components)) fail(token, 'expected an sRGB colour');
  const components = value.components.map((component) => (typeof component === 'number' ? component : fail(token, 'non-numeric component')));
  const computed = `#${components.map((component) => Math.round(component * 255).toString(16).padStart(2, '0')).join('')}`;
  if (typeof value.hex === 'string' && value.hex.toLowerCase() !== computed) fail(token, `hex ${value.hex} disagrees with components (${computed})`);
  return computed;
}

function dimensionApx(token: Token, value: Json): number {
  if (!isObject(value) || typeof value.value !== 'number') fail(token, 'expected a dimension');
  if (value.unit === 'px') return value.value;
  if (value.unit === 'rem') return Math.round(value.value * REM_PX * 1000) / 1000;
  return fail(token, `unsupported unit ${String(value.unit)}`);
}

function dimensionCss(token: Token, value: Json): string {
  if (!isObject(value) || typeof value.value !== 'number' || (value.unit !== 'px' && value.unit !== 'rem')) fail(token, 'expected a px or rem dimension');
  return `${value.value}${value.unit}`;
}

function durationMs(token: Token, value: Json): number {
  if (!isObject(value) || typeof value.value !== 'number' || value.unit !== 'ms') fail(token, 'expected a duration in ms');
  return value.value;
}

function numbers(token: Token, value: Json, length?: number): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number') || (length !== undefined && value.length !== length)) {
    fail(token, `expected ${length ?? 'a list of'} numbers`);
  }
  return value as number[];
}

function strings(token: Token, value: Json): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(token, 'expected font family names');
  return value as string[];
}

function field(token: Token, value: Json, key: string): Json {
  if (!isObject(value) || !(key in value)) fail(token, `missing ${key}`);
  return value[key]!;
}

function num(token: Token, value: Json): number {
  return typeof value === 'number' ? value : fail(token, 'expected a number');
}

/** The value code reads: sRGB hex colours, apx sizes, ms durations, plain numbers. */
export function toCodeValue(token: Token): Json {
  const { type, value } = token;
  switch (type) {
    case 'color': return hexOf(token, value);
    case 'dimension': return dimensionApx(token, value);
    case 'duration': return durationMs(token, value);
    case 'number': return num(token, value);
    case 'cubicBezier': return numbers(token, value, 4);
    case 'fontFamily': return strings(token, value);
    case 'gradient':
      if (!Array.isArray(value)) fail(token, 'expected gradient stops');
      return value.map((stop) => ({ color: hexOf(token, field(token, stop, 'color')), position: num(token, field(token, stop, 'position')) }));
    case 'typography':
      return {
        fontFamily: strings(token, field(token, value, 'fontFamily')),
        fontWeight: num(token, field(token, value, 'fontWeight')),
        fontSize: dimensionApx(token, field(token, value, 'fontSize')),
        letterSpacing: dimensionApx(token, field(token, value, 'letterSpacing')),
        lineHeight: num(token, field(token, value, 'lineHeight'))
      };
    default: return fail(token, 'unsupported $type; add it to the generator deliberately');
  }
}

function cssName(parts: string[]): string {
  return `--holoim-${parts.map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()).join('-')}`;
}

function fontStack(families: string[]): string {
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);
  return families.map((family) => (generic.has(family) ? family : `"${family}"`)).join(', ');
}

/** CSS custom properties for one token; colours also get an `-rgb` triplet for `rgb(var(…) / a)`. */
function toCssDeclarations(token: Token): Array<[string, string]> {
  const name = cssName(token.path);
  const { type, value } = token;
  switch (type) {
    case 'color': {
      const hex = hexOf(token, value);
      const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(' ');
      return [[name, hex], [`${name}-rgb`, rgb]];
    }
    case 'dimension': return [[name, dimensionCss(token, value)]];
    case 'duration': return [[name, `${durationMs(token, value)}ms`]];
    case 'number': return [[name, String(num(token, value))]];
    case 'cubicBezier': return [[name, `cubic-bezier(${numbers(token, value, 4).join(', ')})`]];
    case 'fontFamily': return [[name, fontStack(strings(token, value))]];
    case 'gradient': {
      const stops = (toCodeValue(token) as Array<{ color: string; position: number }>)
        .map((stop) => `${stop.color} ${Math.round(stop.position * 10000) / 100}%`);
      return [[`${name}-stops`, stops.join(', ')]];
    }
    case 'typography': return [
      [`${name}-font-family`, fontStack(strings(token, field(token, value, 'fontFamily')))],
      [`${name}-font-weight`, String(num(token, field(token, value, 'fontWeight')))],
      [`${name}-font-size`, dimensionCss(token, field(token, value, 'fontSize'))],
      [`${name}-letter-spacing`, dimensionCss(token, field(token, value, 'letterSpacing'))],
      [`${name}-line-height`, String(num(token, field(token, value, 'lineHeight')))]
    ];
    default: return fail(token, 'unsupported $type');
  }
}

function setPath(target: JsonObject, parts: string[], value: Json) {
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node[part] ??= {};
    node = node[part] as JsonObject;
  }
  node[parts.at(-1)!] = value;
}

function tsLiteral(value: Json, indent: string): string {
  if (Array.isArray(value)) {
    if (value.every((item) => !isObject(item))) return `[${value.map((item) => tsLiteral(item, indent)).join(', ')}]`;
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${tsLiteral(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (isObject(value)) {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(([key, item]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`}: ${tsLiteral(item, inner)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
  }
  return typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(value);
}

const HEADER = '// Generated by packages/design-tokens/scripts/generate.ts from\n// docs/product/design/tokens.json. Do not edit; run `pnpm --filter @holoim/design-tokens run generate`.\n';

export interface GeneratedFiles {
  'tokens.ts': string;
  'tokens.css': string;
  'tokens.json': string;
}

export function generate(source: JsonObject): GeneratedFiles {
  const tokens = resolveAliases(collectTokens(source));
  const tree: JsonObject = {};
  const flat: JsonObject = {};
  const css: string[] = [];
  for (const token of tokens) {
    const value = toCodeValue(token);
    setPath(tree, token.path, value);
    flat[token.path.join('.')] = value;
    for (const [name, declaration] of toCssDeclarations(token)) css.push(`  ${name}: ${declaration};`);
  }
  return {
    'tokens.ts': `${HEADER}// Colours are sRGB hex; sizes are apx (1 apx = 1 CSS reference px); durations\n// are ms; plain numbers under edge are shares of the hologram's short side.\n\nexport const tokens = ${tsLiteral(tree, '')} as const;\n\nexport type Tokens = typeof tokens;\n`,
    'tokens.css': `/* ${HEADER.replace(/\/\/ /g, '').trim()} */\n\n:root {\n${css.join('\n')}\n}\n`,
    'tokens.json': `${JSON.stringify(flat, null, 2)}\n`
  };
}

export async function readTokenFile(file = TOKEN_FILE): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Json;
  if (!isObject(parsed)) throw new TokenError(`${file} is not a token tree`);
  return parsed;
}

/** Names of the committed outputs that differ from a fresh generation. */
export async function findDrift(outputDir = OUTPUT_DIR, file = TOKEN_FILE): Promise<string[]> {
  const files = generate(await readTokenFile(file));
  const drifted: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const committed = await readFile(path.join(outputDir, name), 'utf8').catch(() => null);
    if (committed !== content) drifted.push(name);
  }
  return drifted;
}

async function main() {
  if (process.argv.includes('--check')) {
    const drifted = await findDrift();
    if (drifted.length > 0) {
      console.error(`[design-tokens] ${drifted.join(', ')} out of date with docs/product/design/tokens.json; run pnpm --filter @holoim/design-tokens run generate`);
      process.exit(1);
    }
    console.log('[design-tokens] generated outputs match tokens.json');
    return;
  }
  const files = generate(await readTokenFile());
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(OUTPUT_DIR, name), content, 'utf8');
  console.log(`[design-tokens] wrote ${Object.keys(files).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
