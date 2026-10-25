// The chrome flag: a structural mark on every chrome object (stage controls,
// chip, labels, Halo, fingertip shade, edge), so recording, export and point
// resolution skip it. Structural, not `instanceof`, because three.js values
// cross module and package boundaries where constructor identity breaks.

export const CHROME_FLAG = "holoimChrome";

export interface ChromeObjectLike {
  userData: Record<string, unknown>;
  parent?: ChromeObjectLike | null;
  children?: readonly ChromeObjectLike[];
}

/** Marks one object as chrome. */
export function markChrome<T extends ChromeObjectLike>(object: T): T {
  object.userData[CHROME_FLAG] = true;
  return object;
}

/** Marks an object and every descendant it has now. */
export function markChromeTree<T extends ChromeObjectLike>(root: T): T {
  const stack: ChromeObjectLike[] = [root];
  while (stack.length > 0) {
    const object = stack.pop()!;
    markChrome(object);
    if (object.children) stack.push(...object.children);
  }
  return root;
}

/** Whether this object is chrome. */
export function isChrome(object: { userData?: Record<string, unknown> } | null | undefined): boolean {
  return object?.userData?.[CHROME_FLAG] === true;
}

/** Whether this object or any ancestor is chrome: for raycast hits and samplers walking a scene. */
export function isInChrome(object: ChromeObjectLike | null | undefined): boolean {
  for (let node = object; node; node = node.parent ?? null) {
    if (isChrome(node)) return true;
  }
  return false;
}
