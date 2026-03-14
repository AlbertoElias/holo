export function pickActiveCard(entries: IntersectionObserverEntry[]): string | null {
  const candidates = entries
    .filter((entry) => entry.isIntersecting)
    .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

  if (candidates.length === 0) {
    return null;
  }

  const topCandidate = candidates[0];
  if (!topCandidate) {
    return null;
  }

  const id = topCandidate.target.getAttribute("data-card-id");
  return id;
}
