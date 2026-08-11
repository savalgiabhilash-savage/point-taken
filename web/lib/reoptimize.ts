// Fire the fast optimize-only GitHub workflow so the Optimizer plan reflects a just-changed team,
// instead of waiting for the 3-hourly data pipeline. Best-effort by design: if the token is missing
// or GitHub hiccups, the user's action still succeeds and the cron re-optimizes later.
const REPO = "savalgiabhilash-savage/fpl-selector";

export async function triggerReoptimize(opts?: { horizon?: number; userId?: string }): Promise<boolean> {
  const token = [...(process.env.GITHUB_DISPATCH_TOKEN ?? "")]
    .filter((c) => c.charCodeAt(0) !== 0xfeff)
    .join("")
    .trim();
  if (!token) return false;
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
    return res.ok;
  } catch {
    // swallowed on purpose — never let a re-optimize trigger fail a team upload/sync
    return false;
  }
}
