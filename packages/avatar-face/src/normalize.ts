/**
 * Lowercases a morph/expression name, strips common exporter prefixes and
 * `<word>.` namespaces, and drops `_`, `-`, spaces and dots.
 */
export function normalizeMorphName(name: string): string {
  let s = name.trim().replace(/^[^.]*\./, "").toLowerCase();
  s = s.replace(/^(bs_|head_|mesh_)/, "");
  return s.replace(/[_\-\s.]/g, "");
}
