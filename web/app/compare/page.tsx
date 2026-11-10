import { loadCompare } from "@/lib/compare";
import { loadCompareDetails, HORIZONS, type Horizon } from "@/lib/compare-detail";
import { Compare } from "@/components/compare";
import { PageHeader } from "@/components/shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare players" };

// Compare 2–3 players side by side. ?p=1,2,3 picks them and ?h=1|3|5|8 the horizon (the page keeps both in
// the URL, so a comparison can be shared); with no ?p it starts with the two highest-projected players.
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ p?: string; h?: string }> }) {
  const sp = await searchParams;
  const fromUrl = (sp.p ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 3);
  const h = (HORIZONS as readonly number[]).includes(Number(sp.h)) ? (Number(sp.h) as Horizon) : 5;

  const { players, gws } = await loadCompare();
  // One player (from a "Compare" button): add a suggested rival, the highest-projected player in the same
  // position within £1m of his price, else the highest-projected in his position at any price.
  // None given: the two highest-projected players.
  let ids = fromUrl.length ? fromUrl : players.slice(0, 2).map((p) => p.id);
  if (ids.length === 1) {
    const me = players.find((p) => p.id === ids[0]);
    const samePos = me ? players.filter((p) => p.id !== me.id && p.pos === me.pos) : []; // sorted by xPts
    const rival = samePos.find((p) => Math.abs(p.price - me!.price) <= 1) ?? samePos[0];
    if (rival) ids = [ids[0], rival.id];
  }
  const details = await loadCompareDetails(ids, h);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Compare players">
        <ul>
          <li>• Put 2 or 3 players side by side, Ultimate Team style: overall rating, six attributes and the key FPL numbers</li>
          <li>• Pick a horizon for the points range, where the points come from, DefCon, attack and minutes; ▲ marks the best in each row</li>
          <li>• Card ratings always use the next {gws.length} GWs (explained at the bottom)</li>
        </ul>
      </PageHeader>
      <Compare players={players} initial={ids} gws={gws} details={details} horizon={h} />
    </main>
  );
}
