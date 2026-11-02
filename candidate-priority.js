export const PRIORITY_SEEDS = Object.freeze([
  'sikkokusimeji', 'rosanna_lips', 'hono9556', 'potemushi', 'sessha', 'akari_seaart',
]);

/** Validate public priority evidence and return it in the shared display order. */
export function normalizePrioritySources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PRIORITY_SEEDS.length ||
      value.some(source => typeof source !== 'string' || !PRIORITY_SEEDS.includes(source)) ||
      new Set(value).size !== value.length) throw new TypeError('Invalid priority sources');
  return PRIORITY_SEEDS.filter(source => value.includes(source));
}

/** More shared priority sources first, then the existing follow gap and recency. */
export function rankCandidates(a, b) {
  return normalizePrioritySources(b.prioritySources).length - normalizePrioritySources(a.prioritySources).length ||
    b.gap - a.gap || Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}
