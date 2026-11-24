// Which plan horizon to use, from evidence (worker/fpl_worker/optimizer_backtest.py, rules-v8, 2026-11-24):
// - REPLAY: actual points over 2023/24–2025/26, following the optimizer every week at that horizon (no chips).
// - LEAD_SKILL: how well projections k GWs ahead rank players vs the next GW's (correlation with actual points,
//   lead 0 = next GW = 100%). Accuracy falls slowly: ~89% four weeks out, ~80% by 18.
export const HORIZON_REPLAY: Record<number, number> = {
  1: 6794, 2: 7119, 3: 7356, 4: 7474, 5: 7368, 6: 7459, 8: 7551, 10: 7532, 12: 7623, 15: 7525, 19: 7572,
};
// 8–19 GWs form a plateau (within ~100 pts, noise between seasons); 12 scored most and beat 8 in 2 of 3 seasons.
export const RECOMMENDED_HORIZON = 12;
const LEAD_SKILL = [1.0, 0.96, 0.93, 0.908, 0.891, 0.88, 0.865, 0.856, 0.846, 0.837, 0.827, 0.822, 0.818, 0.814, 0.813, 0.81, 0.806, 0.803, 0.801];

/** Accuracy of the furthest GW in a plan of h GWs, as a share of next-GW accuracy. */
export function furthestSkill(h: number): number {
  return LEAD_SKILL[Math.min(h, LEAD_SKILL.length) - 1];
}

/** Replay points at the tested horizon nearest h, and the best tested total. */
export function replayFor(h: number): { h: number; pts: number; best: number } {
  const keys = Object.keys(HORIZON_REPLAY).map(Number);
  const near = keys.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  return { h: near, pts: HORIZON_REPLAY[near], best: Math.max(...Object.values(HORIZON_REPLAY)) };
}
