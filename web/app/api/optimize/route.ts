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

  const r = await triggerReoptimize({ horizon, userId: user.id });
  if (!r.ok) {
    const msg =
      r.error === "no-token"
        ? "GITHUB_DISPATCH_TOKEN isn't set on the server."
        : r.status === 401
          ? "GitHub rejected the token (401 Bad credentials) — it's wrong or truncated. Regenerate a fine-grained token and paste the full value."
          : r.status === 403
            ? "GitHub returned 403 — the token needs 'Actions: Read and write' permission on the repo (and, for fine-grained tokens, approval for it)."
            : r.status === 404
              ? "GitHub returned 404 — the token can't see the repo or the workflow (check repository access)."
              : r.status === 422
                ? "GitHub rejected the workflow inputs (422)."
                : `Couldn't start the optimization (GitHub ${r.status ?? "network error"}).`;
    return Response.json({ error: msg, status: r.status }, { status: 502 });
  }
  return Response.json({ started: true, horizon });
}
