import { buildInsight } from "@/lib/insight";

export const runtime = "nodejs";

// GET /api/insight?id=<fpl_id> — the factor-by-factor explanation behind a player's projection.
// Public: it only reads shared model data (no personal team data).
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Bad player id." }, { status: 400 });
  const insight = await buildInsight(id);
  if (!insight) return Response.json({ error: "Player not found." }, { status: 404 });
  return Response.json(insight, { headers: { "cache-control": "private, max-age=300" } });
}
