// Which plan horizon to use, from evidence (worker/fpl_worker/optimizer_backtest.py, rules-v8, 2026-11-24):
// - REPLAY: actual points over 2023/24–2025/26, following the optimizer and its chip plan every week at that horizon.
// - LEAD_SKILL: how well projections k GWs ahead rank players vs the next GW's (correlation with actual points,
//   lead 0 = next GW = 100%). Accuracy falls slowly: ~89% four weeks out, ~80% by 18.
export const HORIZON_REPLAY: Record<number, number> = {
  5: 7782, 6: 7733, 8: 7925, 10: 7693, 12: 7696, 15: 7690,
};
// With chips, 8 GWs scored most and beat 12 in all three seasons (2,692 · 2,789 · 2,444 vs 2,592 · 2,685 · 2,419);
// without chips 8 and 12 were close (7,551 vs 7,623), so 8 is best overall (2026-11-25).
export const RECOMMENDED_HORIZON = 8;
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
