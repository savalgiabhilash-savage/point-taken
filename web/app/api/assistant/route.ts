import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool } from "@/lib/assistant-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `You are the FPL Assistant for the user's personal Fantasy Premier League team. You answer questions about captaincy, transfers, taking −4 hits, chip timing, and individual players.

Grounding rules (strict):
- Only state facts you retrieved from a tool. Never invent or estimate numbers (xPts, price, ownership, fixtures) that a tool did not return.
- Always cite the specific numbers you used, e.g. "Haaland — 6.2 xPts, £15.5m".
- If the tools don't cover something, say so plainly instead of guessing.
- For "what should I do" / transfer / hit / chip questions, call get_optimizer_plan first — it already computes the recommended transfers, captain, and chip timing for the user's team — and cite it.
- For the user's own team use get_my_team; for the best team this week use get_best_xi; for shortlists use list_top_players; for one player use get_player.
- xPts is a rules-based model projection (rules-v1); be appropriately measured about certainty.

Be concise: lead with the answer, then the supporting numbers. It is preseason / early season.`;

function badKey(): string {
  // The key may carry a BOM if it was stored via a Windows pipe; strip it defensively.
  return [...(process.env.ANTHROPIC_API_KEY ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();
}

export async function POST(req: Request) {
  const apiKey = badKey();
  if (!apiKey) {
    return Response.json(
      { error: "The assistant isn't configured yet (missing ANTHROPIC_API_KEY on the server)." },
      { status: 503 },
    );
  }

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const incoming = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  if (!incoming.length) return Response.json({ error: "No message provided." }, { status: 400 });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = incoming.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  try {
    let response: Anthropic.Message | null = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS as Anthropic.Tool[],
        messages,
      });
      if (response.stop_reason !== "tool_use") break;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let out: unknown;
        try {
          out = await runTool(tu.name, tu.input);
        } catch (err) {
          out = { error: err instanceof Error ? err.message : String(err) };
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }

    const answer = (response?.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return Response.json({ answer: answer || "I couldn't find an answer for that in your data." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/credit balance|billing|insufficient|quota/i.test(msg)) {
      return Response.json(
        { error: "The assistant is out of Anthropic credits. Add credits at console.anthropic.com → Plans & Billing, then try again." },
        { status: 402 },
      );
    }
    return Response.json({ error: `Assistant error: ${msg}` }, { status: 500 });
  }
}
