// Fire the fast optimize-only GitHub workflow so the Optimizer plan reflects a just-changed team,
// instead of waiting for the 3-hourly data pipeline. Best-effort by design: if the token is missing
// or GitHub hiccups, the user's action still succeeds and the cron re-optimizes later.
const REPO = "savalgiabhilash-savage/point-taken";

export type DispatchResult = { ok: boolean; status: number | null; error?: string };

export async function triggerReoptimize(opts?: { horizon?: number; userId?: string }): Promise<DispatchResult> {
  const token = [...(process.env.GITHUB_DISPATCH_TOKEN ?? "")]
    .filter((c) => c.charCodeAt(0) !== 0xfeff)
    .join("")
    .trim();
  if (!token) return { ok: false, status: null, error: "no-token" };
  const inputs: Record<string, string> = {};
  if (opts?.horizon) inputs.horizon = String(opts.horizon);
  if (opts?.userId) inputs.user_id = opts.userId;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/optimize.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "fpl-selector",
      },
      body: JSON.stringify({ ref: "master", inputs }),
    });
    if (res.ok) return { ok: true, status: res.status };
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, error: body || `HTTP ${res.status}` };
  } catch (e) {
    // never let a re-optimize trigger throw into a team upload/sync
    return { ok: false, status: null, error: e instanceof Error ? e.message : "fetch-failed" };
  }
}
