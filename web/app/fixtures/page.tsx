import { createSupabaseServerClient } from "@/lib/supabase";
import { PageHeader } from "@/components/shell";
import { FixtureTicker, type View } from "@/components/fixture-ticker";
import { loadTicker, FORM_GAMES, FORM_W } from "@/lib/ticker";

export const dynamic = "force-dynamic";

// Fixture ticker: difficulty from each opponent's current form blended with the model, coloured relative to
// every fixture shown (lib/ticker.ts, components/fixture-ticker.tsx).
// ?view=attack|defence|overall and ?h=1|3|5|8 pre-set the controls (the command box links here with them).
export default async function FixturesPage({ searchParams }: { searchParams: Promise<{ view?: string; h?: string }> }) {
  const sp = await searchParams;
  const view = (["overall", "attack", "defence"] as View[]).find((v) => v === sp.view) ?? "overall";
  const h = [1, 3, 5, 8].includes(Number(sp.h)) ? Number(sp.h) : 5;
  const { teams, gws } = await loadTicker(createSupabaseServerClient());
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Fixture Ticker">
        <ul>
          <li>• How easy each club&apos;s next fixtures are, from the opponent&apos;s current form ({Math.round(FORM_W * 100)}%) and the model ({100 - Math.round(FORM_W * 100)}%)</li>
          <li>• Attack view for forwards and midfielders, Defence for clean sheets, Overall for both</li>
          <li>• Colours are relative: each fixture is ranked against all the others shown, in five equal bands</li>
          <li>• Clubs with the easiest run over your horizon are at the top; tap a fixture for the numbers</li>
        </ul>
      </PageHeader>
      <FixtureTicker teams={teams} gws={gws} formGames={FORM_GAMES} formWeight={FORM_W} initialView={view} initialH={h} />
    </main>
  );
}
