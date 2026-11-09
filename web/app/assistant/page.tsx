"use client";

import * as React from "react";
import { PageHeader } from "@/components/shell";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Who should I captain this week?",
  "What transfer should I make?",
  "When should I play my chips?",
  "Best midfielders under £8.0m?",
];

export default function AssistantPage() {
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      setMessages([...next, { role: "assistant", content: data.answer ?? data.error ?? "Something went wrong." }]);
    } catch {
      setMessages([...next, { role: "assistant", content: "Network error — please try again." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-3xl flex-col px-4 py-5 sm:px-6 sm:py-8">
      <PageHeader title="Assistant">
        <ul>
          <li>• Ask about captaincy, transfers, hits, chips or any player</li>
          <li>• Answers use your live data and cite the numbers; it won&apos;t invent stats</li>
        </ul>
      </PageHeader>

      <div className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-border bg-card p-4">
        {messages.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">Try one of these:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-brand/60 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-500/15 px-3.5 py-2 text-sm text-foreground"
                    : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground"
                }
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your team…"
          className="h-11 flex-1 rounded-2xl border border-border bg-card px-4 text-base outline-none sm:text-sm focus:border-brand/60"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="h-11 press rounded-md bg-grad glow px-5 text-sm font-bold uppercase tracking-wide hover:brightness-110 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}
