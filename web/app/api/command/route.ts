import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool } from "@/lib/assistant-tools";
import { BOX, EXTRA_TOOLS, hrefFor, taskFor } from "@/lib/command-prompt";
import { createServerSupabase } from "@/lib/supabase/server";
import { addUsage, emptyUsage, logUsage } from "@/lib/ai-usage";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 6;

// The command box: prompt, extra tools and how their inputs become a link or a task are in lib/command-prompt.ts.

const key = () => [...(process.env.ANTHROPIC_API_KEY ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();

export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Log in to use the command box." }, { status: 401 });
  const userId = auth.user.id;
  const apiKey = key();
  if (!apiKey) return Response.json({ error: "Missing ANTHROPIC_API_KEY on the server." }, { status: 503 });

  const { q } = (await req.json().catch(() => ({}))) as { q?: string };
  const text = (q ?? "").trim().slice(0, 500);
  if (!text) return Response.json({ error: "Type what you want." }, { status: 400 });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: text }];
  let usage = emptyUsage();
  let calls = 0;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await client.messages.create({
        model: MODEL, max_tokens: 700, system: BOX, tools: [...TOOLS, ...EXTRA_TOOLS] as Anthropic.Tool[], messages,
      });
      usage = addUsage(usage, res.usage);
      calls++;
      const said = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const end = uses.find((u) => u.name === "open_page" || u.name === "propose_task");
      if (end) {
        const input = (end.input ?? {}) as Record<string, unknown>;
        await logUsage(sb, userId, "command", MODEL, usage, calls);
        if (end.name === "open_page") {
          const href = hrefFor(input);
          if (href) return Response.json({ open: href, answer: (typeof input.note === "string" && input.note) || said || null });
        } else {
          const task = taskFor(input);
          if (task) return Response.json({ task, answer: said || null });
        }
        return Response.json({ answer: said || "I couldn't work out where to take you. Try rephrasing." });
      }
      if (res.stop_reason !== "tool_use") {
        await logUsage(sb, userId, "command", MODEL, usage, calls);
        return Response.json({ answer: said || "I couldn't find an answer for that in your data." });
      }
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of uses) {
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
    await logUsage(sb, userId, "command", MODEL, usage, calls);
    return Response.json({ answer: "That took too many steps. Try a more specific request, or ask on the Assistant page." });
  } catch (err) {
    await logUsage(sb, userId, "command", MODEL, usage, calls);
    const msg = err instanceof Error ? err.message : String(err);
    if (/credit balance|billing|insufficient|quota/i.test(msg)) {
      return Response.json({ error: "Out of Anthropic credits. Add credits at console.anthropic.com, then try again." }, { status: 402 });
    }
    return Response.json({ error: `Command error: ${msg}` }, { status: 500 });
  }
}
