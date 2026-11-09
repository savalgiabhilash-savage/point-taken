import { loadCompare } from "@/lib/compare";
import { Compare } from "@/components/compare";
import { PageHeader } from "@/components/shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare players" };

// Compare 2–3 players side by side. ?p=1,2,3 picks them (the page keeps it updated, so a comparison can be
// shared); with no ?p it starts with the two highest-projected players.
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const [{ players, gws }, sp] = await Promise.all([loadCompare(), searchParams]);
  const fromUrl = (sp.p ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const initial = fromUrl.length ? fromUrl : players.slice(0, 2).map((p) => p.id);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Compare players">
        <ul>
          <li>• Put 2 or 3 players side by side, Ultimate Team style: overall rating, six attributes and the key FPL numbers</li>
          <li>• Ratings turn each player&apos;s own numbers into FC-style scores out of 99 (explained at the bottom); the best in each row is marked ▲</li>
        </ul>
      </PageHeader>
      <Compare players={players} initial={initial} gws={gws} />
    </main>
  );
}
