import { createServerSupabase } from "@/lib/supabase/server";
import { triggerReoptimize } from "@/lib/reoptimize";

export const runtime = "nodejs";

// On-demand optimize: the user clicks "Optimize my squad" (with a chosen horizon) on the Optimizer
// page. The MILP runs in the cloud (GitHub Actions) against their current squad; this route just
// validates and dispatches it. The result lands in optimizer_runs a minute or two later.
export async function POST(req: Request) {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  let horizon = 5;
  try {
    const body = (await req.json()) as { horizon?: number };
    const h = Number(body?.horizon);
    if (Number.isInteger(h) && h >= 1 && h <= 38) horizon = h;
  } catch {
    // keep the default
  }

  const ok = await triggerReoptimize({ horizon, userId: user.id });
  if (!ok) {
    return Response.json(
      { error: "On-demand optimize isn't set up yet (missing GITHUB_DISPATCH_TOKEN)." },
      { status: 503 },
    );
  }
  return Response.json({ started: true, horizon });
}
