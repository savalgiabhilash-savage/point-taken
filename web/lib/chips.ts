// One chip verdict for every screen (Optimizer, Chips, This week, assistant). The worker plans one chip at a
// time (optimize.py _chip_plan): the held chip that most clears its bar, played when its best week arrives.
export type ChipStatus = "now" | "planned" | "hold" | "used";

export type ChipVerdictInput = {
  chip: string;
  gw: number;
  available: boolean;
  plan_gw?: number | null;
  play_now?: boolean;
};

export function chipStatus(c: ChipVerdictInput): ChipStatus {
  if (!c.available) return "used";
  if (c.play_now) return "now";
  return c.plan_gw ? "planned" : "hold";
}

export function chipStatusLabel(c: ChipVerdictInput): string {
  const s = chipStatus(c);
  if (s === "used") return "used";
  if (s === "now") return `play this GW (GW${c.gw})`;
  if (s === "planned") return `planned GW${c.plan_gw}`;
  return `hold · best GW${c.gw}`;
}
