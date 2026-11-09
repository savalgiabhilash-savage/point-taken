import { createSupabaseServerClient, MODEL_VERSION, type Position } from "@/lib/supabase";
import { DIFFERENTIAL_OWNERSHIP } from "@/lib/insight";
import { PlayerInfo } from "@/components/player-info";
import { PageHeader } from "@/components/shell";

export const dynamic = "force-dynamic";

const HORIZON = 5;
const PER_POSITION = 5;
const MIN_START = 0.6; // a differential you can't rely on to start isn't worth the slot
const PRICE_BAND = 10; // ±£1.0m (tenths) when finding the popular alternative
const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

type P = {
  fpl_id: number;
  web_name: string;
  position: Position;
  now_cost: number;
  selected_by_percent: number | null;
  status: string | null;
  team: { short_name: string } | null;
};
type Proj = { player_id: number; gw: number; x_pts: number; components: Record<string, unknown> | null };

// Differentials: low-owned players the model rates highly over the next few GWs. A differential's haul
// gains rank on most rivals, a template player's haul mostly just keeps pace.
export default async function DifferentialsPage() {
  const sb = createSupabaseServerClient();
  const { data: first } = await sb
    .from("projections").select("gw").eq("model_version", MODEL_VERSION).order("gw", { ascending: true }).limit(1);
  const nextGw = (first?.[0]?.gw as number | undefined) ?? null;

  const { data: playerRows } = await sb
    .from("players")
    .select("fpl_id, web_name, position, now_cost, selected_by_percent, status, team:teams(short_name)");
  const players = (playerRows ?? []) as unknown as P[];

  const xp5 = new Map<number, number>();
  if (nextGw != null) {
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("projections")
        .select("player_id, x_pts")
        .eq("model_version", MODEL_VERSION)
        .gte("gw", nextGw)
        .lt("gw", nextGw + HORIZON)
        .order("player_id")
        .order("gw")
        .range(from, from + 999);
      for (const r of data ?? []) xp5.set(r.player_id, (xp5.get(r.player_id) ?? 0) + (r.x_pts ?? 0));
      if ((data ?? []).length < 1000) break;
    }
  }
  const own = (p: P) => Number(p.selected_by_percent ?? 0);
  const pts = (p: P) => xp5.get(p.fpl_id) ?? 0;

  // Rank everyone by position, then shortlist low-owned, available players.
  const rankIn = new Map<number, number>();
  for (const pos of POSITIONS) {
    players.filter((p) => p.position === pos).sort((a, b) => pts(b) - pts(a)).forEach((p, i) => rankIn.set(p.fpl_id, i + 1));
  }
  const shortlist = new Map<Position, P[]>();
  for (const pos of POSITIONS) {
    shortlist.set(
      pos,
      players
        .filter((p) => p.position === pos && own(p) < DIFFERENTIAL_OWNERSHIP && p.status !== "i" && p.status !== "s" && p.status !== "u" && pts(p) > 0)
        .sort((a, b) => pts(b) - pts(a))
        .slice(0, PER_POSITION * 3),
    );
  }
  const candIds = [...shortlist.values()].flat().map((p) => p.fpl_id);
  const { data: projRows } = nextGw == null
    ? { data: [] as Proj[] }
    : await sb
        .from("projections")
        .select("player_id, gw, x_pts, components")
        .eq("model_version", MODEL_VERSION)
        .gte("gw", nextGw)
        .lt("gw", nextGw + HORIZON)
        .in("player_id", candIds.length ? candIds : [0])
        .order("gw");
  const byPlayer = new Map<number, Proj[]>();
  for (const r of (projRows ?? []) as Proj[]) byPlayer.set(r.player_id, [...(byPlayer.get(r.player_id) ?? []), r]);

  const { data: newsRows } = await sb.from("news_sentiment").select("player_id, summary, topics").in("player_id", candIds.length ? candIds : [0]);
  const news = new Map((newsRows ?? []).map((n) => [n.player_id as number, n]));

  const sections = POSITIONS.map((pos) => {
    const posCount = players.filter((p) => p.position === pos).length;
    const picks = (shortlist.get(pos) ?? [])
      .filter((p) => {
        const c = byPlayer.get(p.fpl_id)?.[0]?.components as { p_start?: number } | undefined;
        return (c?.p_start ?? 0) >= MIN_START;
      })
      .slice(0, PER_POSITION)
      .map((p) => {
        const rows = byPlayer.get(p.fpl_id) ?? [];
        const c0 = (rows[0]?.components ?? {}) as {
          p_start?: number;
          why?: { recent_starts: number; recent_games: number };
        };
        const opps = rows.flatMap((r) => ((r.components as { opponents?: string[] } | null)?.opponents ?? []));
        const xgFor = rows.flatMap((r) => ((r.components as { team_xg_for?: number[] } | null)?.team_xg_for ?? []));
        const avgFor = xgFor.length ? xgFor.reduce((s, v) => s + v, 0) / xgFor.length : null;
        // The most-owned player at the same position and a similar price: the "template" alternative.
        const template = players
          .filter((q) => q.position === pos && q.fpl_id !== p.fpl_id && Math.abs(q.now_cost - p.now_cost) <= PRICE_BAND && own(q) >= DIFFERENTIAL_OWNERSHIP)
          .sort((a, b) => own(b) - own(a))[0];
        const bullets: string[] = [
          `Owned by ${own(p).toFixed(1)}%: a haul gains rank on about ${Math.round(100 - own(p))}% of managers`,
          `${pts(p).toFixed(1)} pts projected over the next ${HORIZON} GWs, #${rankIn.get(p.fpl_id)} of ${posCount} ${pos}s`,
        ];
        if (template) {
          const d = pts(p) - pts(template);
          bullets.push(
            `vs popular pick ${template.web_name} (${own(template).toFixed(0)}% owned, £${(template.now_cost / 10).toFixed(1)}m): ${d >= 0 ? "+" : ""}${d.toFixed(1)} pts`,
          );
        }
        if (opps.length) bullets.push(`Fixtures: ${opps.map((o) => (o.startsWith("@") ? `${o.slice(1)} (A)` : `${o} (H)`)).join(", ")}`);
        if (avgFor != null) bullets.push(`His team is expected to score ${avgFor.toFixed(2)} a game over that run`);
        if (c0.p_start != null)
          bullets.push(
            `${Math.round(c0.p_start * 100)}% chance to start${c0.why?.recent_games ? `; started ${c0.why.recent_starts} of the last ${c0.why.recent_games}` : ""}`,
          );
        bullets.push(`Value: ${(pts(p) / (p.now_cost / 10)).toFixed(2)} pts per £m at £${(p.now_cost / 10).toFixed(1)}m`);
        const n = news.get(p.fpl_id);
        if (n?.summary) bullets.push(`News: ${n.summary}`);
        if (p.status === "d") bullets.push("Risk: flagged as doubtful by FPL");
        return { p, bullets };
      });
    return { pos, picks };
  });

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Differentials">
        <ul>
        <li>• Players owned by under {DIFFERENTIAL_OWNERSHIP}% whom the model rates highly over the next {HORIZON} GWs</li>
        <li>• Only players with at least a {Math.round(MIN_START * 100)}% chance to start</li>
        <li>• A differential&apos;s haul gains you rank; a popular player&apos;s haul mostly keeps pace</li>
        <li>• Your Optimizer still picks on projected points; differentials get a D badge wherever they appear</li>
        <li>• Tap the i for the full reasoning</li>
      </ul>
      </PageHeader>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {sections.map(({ pos, picks }) => (
          <section key={pos}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{pos}</div>
            {picks.length ? (
              <ul className="space-y-3">
                {picks.map(({ p, bullets }) => (
                  <li key={p.fpl_id} className="rounded-2xl border border-border bg-card px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.web_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.team?.short_name} · £{(p.now_cost / 10).toFixed(1)}m
                      </span>
                      <span className="ml-auto rounded bg-violet-600 px-1.5 text-[10px] font-bold text-white">
                        {own(p).toFixed(1)}%
                      </span>
                      <PlayerInfo playerId={p.fpl_id} name={p.web_name} why={bullets} />
                    </div>
                    <ul className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
                      {bullets.map((b, i) => (
                        <li key={i}>• {b}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">• No low-owned {pos} currently projects well enough</p>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
