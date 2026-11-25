import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool } from "@/lib/assistant-tools";
import { SYSTEM } from "@/lib/assistant-prompt";
import { createServerSupabase } from "@/lib/supabase/server";
import { addUsage, emptyUsage, logUsage } from "@/lib/ai-usage";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 6;



function badKey(): string {
  // The key may carry a BOM if it was stored via a Windows pipe; strip it defensively.
  return [...(process.env.ANTHROPIC_API_KEY ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();
}

export async function POST(req: Request) {
  // Signed-in users only: every call spends Anthropic credits, so the endpoint must not be open.
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Log in to use the assistant." }, { status: 401 });
  const userId = auth.user.id;

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

  // Token usage across every round of the tool loop, logged once for Settings → AI usage.
  let usage = emptyUsage();
  let calls = 0;
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
      usage = addUsage(usage, response.usage);
      calls++;
      if (response.stop_reason !== "tool_use") break;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let out: unknown;
        try {
          out = await runTool(tu.name, tu.input, userId);
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
    await logUsage(sb, auth.user.id, "assistant", MODEL, usage, calls);
    return Response.json({ answer: answer || "I couldn't find an answer for that in your data." });
  } catch (err) {
    await logUsage(sb, userId, "assistant", MODEL, usage, calls); // rounds that ran before the error still cost
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
