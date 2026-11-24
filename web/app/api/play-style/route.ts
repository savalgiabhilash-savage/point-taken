import { createServerSupabase } from "@/lib/supabase/server";
import { triggerReoptimize } from "@/lib/reoptimize";
import { asGoal, type Risk } from "@/lib/play-style";

export const runtime = "nodejs";

// Save the user's play style (risk profile and/or goal; quiz = mark the quiz done). A risk change re-runs
// the optimizer for this user at their saved horizon, so the plan follows the new style in a minute or two.
export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { risk?: string; goal?: string | null; quiz?: boolean };
  const patch: Record<string, unknown> = { id: auth.user.id, updated_at: new Date().toISOString() };
  const risk = (["safe", "balanced", "bold"] as const).find((r) => r === body.risk) as Risk | undefined;
  if (risk) patch.risk = risk;
  if (body.goal !== undefined) patch.goal = asGoal(body.goal);
  if (body.quiz) patch.quiz_done_at = new Date().toISOString();

  const { data: before } = await sb.from("profiles").select("risk").eq("id", auth.user.id).maybeSingle();
  const { error } = await sb.from("profiles").upsert(patch, { onConflict: "id" });
  if (error) {
    const missing = /column|schema cache/i.test(error.message);
    return Response.json(
      { error: missing ? "Play styles need database migration 0018 first." : "Couldn't save your play style." },
      { status: 500 },
    );
  }
  let replanning = false;
  if (risk && risk !== ((before?.risk as string | undefined) ?? "balanced")) {
    replanning = (await triggerReoptimize({ userId: auth.user.id })).ok;
  }
  return Response.json({ saved: true, replanning });
}
