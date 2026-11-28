import { SYSTEM } from "@/lib/assistant-prompt";
import { DESTS, type Task } from "@/lib/command";
import { RECOMMENDED_HORIZON } from "@/lib/horizon";

// The command box: one typed request -> open the page that shows it (pre-set where the page allows),
// propose a task for the user to confirm, or a short written answer. Same data tools and grounding rules
// as the assistant; the two extra tools end the turn.
export const EXTRA_TOOLS = [
  {
    name: "open_page",
    description:
      "Open the app page that shows what the user asked for. Prefer this whenever a page shows the insight. " +
      "Pages: " + DESTS.map((d) => `${d.key} (${d.desc})`).join("; ") + ". " +
      "compare takes player_ids (2-3 ids from get_player's id). form takes position (GK/DEF/MID/FWD) or team (a club's short name, e.g. ARS, for its profile). " +
      "fixtures takes view (attack for forwards/midfielders, defence for GKs/defenders and clean sheets, overall) and gameweeks (1, 3, 5 or 8).",
    input_schema: {
      type: "object",
      properties: {
        page: { type: "string", enum: DESTS.map((d) => d.key) },
        player_ids: { type: "array", items: { type: "integer" } },
        position: { type: "string", enum: ["GK", "DEF", "MID", "FWD"] },
        team: { type: "string" },
        view: { type: "string", enum: ["attack", "defence", "overall"] },
        gameweeks: { type: "integer", enum: [1, 3, 5, 8] },
        note: { type: "string", description: "One short sentence on what the page shows for this request" },
      },
      required: ["page"],
    },
  },
  {
    name: "propose_task",
    description:
      "When the user asks the app to DO something: reoptimize (re-run the transfer optimizer, optional horizon 1-15 GWs), " +
      "set_risk (play style safe / balanced / bold), sync_team (re-sync their team from FPL). The user confirms before it runs.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["reoptimize", "set_risk", "sync_team"] },
        horizon: { type: "integer" },
        risk: { type: "string", enum: ["safe", "balanced", "bold"] },
      },
      required: ["kind"],
    },
  },
];

export const BOX = `${SYSTEM}

You are answering from the app's command box: the user typed what they want in one line. In order of preference:
1. If an app page shows it, call open_page (pre-set it: for "compare A and B" look up each with get_player and pass their ids; for a club's form pass team).
2. If they want the app to do something (re-optimize, change play style, sync team), call propose_task.
3. Otherwise answer in at most 80 words, using the data tools.
You may call data tools first; open_page or propose_task ends your turn.`;

export function hrefFor(i: Record<string, unknown>): string | null {
  const d = DESTS.find((x) => x.key === i.page);
  if (!d) return null;
  if (d.key === "compare") {
    const ids = (Array.isArray(i.player_ids) ? i.player_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 3);
    return ids.length ? `/compare?p=${ids.join(",")}` : d.href;
  }
  if (d.key === "form") {
    const team = typeof i.team === "string" ? i.team.trim().toLowerCase() : "";
    if (/^[a-z]{3}$/.test(team)) return `/form/${team}`;
    if (typeof i.position === "string" && ["GK", "DEF", "MID", "FWD"].includes(i.position)) return `/form?pos=${i.position}`;
  }
  if (d.key === "fixtures") {
    const q = new URLSearchParams();
    if (i.view === "attack" || i.view === "defence" || i.view === "overall") q.set("view", i.view);
    if ([1, 3, 5, 8].includes(Number(i.gameweeks))) q.set("h", String(i.gameweeks));
    return q.size ? `${d.href}?${q}` : d.href;
  }
  return d.href;
}

export function taskFor(i: Record<string, unknown>): Task | null {
  if (i.kind === "sync_team") return { kind: "sync_team" };
  if (i.kind === "set_risk" && (i.risk === "safe" || i.risk === "balanced" || i.risk === "bold")) return { kind: "set_risk", risk: i.risk };
  if (i.kind === "reoptimize") {
    const h = Number(i.horizon);
    return { kind: "reoptimize", horizon: Number.isInteger(h) && h >= 1 && h <= 15 ? h : RECOMMENDED_HORIZON };
  }
  return null;
}

