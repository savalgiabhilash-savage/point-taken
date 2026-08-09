import Anthropic from "@anthropic-ai/sdk";
import { createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-haiku-4-5";
const ALL_CHIPS = ["wildcard", "freehit", "bboost", "3xc"];
const MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function apiKey(): string {
  return [...(process.env.ANTHROPIC_API_KEY ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();
}

const TOOL: Anthropic.Tool = {
  name: "record_squad",
  description: "Record the 15 players shown in a Fantasy Premier League team screenshot.",
  input_schema: {
    type: "object",
    properties: {
      players: {
        type: "array",
        description: "All 15 players — the 11 starters on the pitch, then the 4 substitutes on the bench.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The player name exactly as shown" },
            position: { type: "string", enum: ["GK", "DEF", "MID", "FWD"] },
            role: { type: "string", enum: ["starter", "bench"], description: "On the pitch or on the bench" },
            is_captain: { type: "boolean", description: "Has the captain (C) armband" },
            is_vice_captain: { type: "boolean", description: "Has the vice-captain (V) armband" },
          },
          required: ["name", "role"],
        },
      },
    },
    required: ["players"],
  },
};

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");

export async function POST(req: Request) {
  const key = apiKey();
  if (!key) return Response.json({ error: "The team reader isn't configured (missing ANTHROPIC_API_KEY)." }, { status: 503 });

  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const m = (body.image ?? "").match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m || !MEDIA.has(m[1])) {
    return Response.json({ error: "Please upload a PNG, JPEG, GIF, or WebP screenshot." }, { status: 400 });
  }
  const mediaType = m[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const data = m[2];

  // 1) Read the squad from the image.
  let players: { name: string; position?: string; role: string; is_captain?: boolean; is_vice_captain?: boolean }[] = [];
  try {
    const resp = await new Anthropic({ apiKey: key }).messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_squad" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            {
              type: "text",
              text: "This is a Fantasy Premier League team. Read all 15 players — the 11 on the pitch (starters) and the 4 on the bench (substitutes). Mark the captain (C armband) and vice-captain (V armband), and give each player's position. Call record_squad.",
            },
          ],
        },
      ],
    });
    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    players = ((tu?.input as { players?: typeof players })?.players) ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/credit balance|billing|insufficient|quota/i.test(msg)) {
      return Response.json({ error: "Out of Anthropic credits — add credits at console.anthropic.com." }, { status: 402 });
    }
    return Response.json({ error: `Couldn't read the image: ${msg}` }, { status: 500 });
  }
  if (!players.length) return Response.json({ error: "Couldn't find a team in that image — try a clearer full-squad screenshot." }, { status: 422 });

  // 2) Match names to real players.
  const { data: dbPlayers } = await supabase.from("players").select("fpl_id, web_name, position, now_cost");
  const pool = dbPlayers ?? [];
  const findPlayer = (name: string) => {
    const q = norm(name);
    if (!q) return null;
    return (
      pool.find((p) => norm(p.web_name) === q) ||
      pool.find((p) => norm(p.web_name).includes(q) || q.includes(norm(p.web_name))) ||
      null
    );
  };

  const picks: { element: number; position: number; is_captain: boolean; is_vice_captain: boolean; multiplier: number }[] = [];
  const matchedNames: string[] = [];
  const unmatched: string[] = [];
  let startPos = 1;
  let benchPos = 12;
  const used = new Set<number>();
  for (const p of players) {
    const hit = findPlayer(p.name);
    if (!hit || used.has(hit.fpl_id)) {
      unmatched.push(p.name);
      continue;
    }
    used.add(hit.fpl_id);
    const starter = p.role === "starter";
    picks.push({
      element: hit.fpl_id,
      position: starter ? startPos++ : benchPos++,
      is_captain: !!p.is_captain,
      is_vice_captain: !!p.is_vice_captain,
      multiplier: p.is_captain ? 2 : 1,
    });
    matchedNames.push(hit.web_name);
  }

  if (picks.length < 11) {
    return Response.json(
      { error: `Only recognised ${picks.length} players from the image — try a clearer screenshot.`, unmatched },
      { status: 422 },
    );
  }

  // 3) Save as the user's squad (preseason draft, gw 0).
  const teamValue = picks.reduce((s, pk) => s + (pool.find((p) => p.fpl_id === pk.element)?.now_cost ?? 0), 0);
  const { error } = await supabase.from("user_team_state").upsert(
    {
      user_id: user.id,
      gw: 0,
      bank: 0,
      team_value: teamValue,
      free_transfers: null,
      chips_available: ALL_CHIPS,
      picks,
      rank: null,
    },
    { onConflict: "user_id,gw" },
  );
  if (error) return Response.json({ error: `Couldn't save the team: ${error.message}` }, { status: 500 });

  return Response.json({ ok: true, count: picks.length, matched: matchedNames, unmatched });
}
