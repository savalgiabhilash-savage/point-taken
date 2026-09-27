"use client";

import * as React from "react";

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
    <main className="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-3xl flex-col px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          <li>• Ask about captaincy, transfers, hits, chips or any player</li>
          <li>• Answers use your live data and cite the numbers; it won&apos;t invent stats</li>
        </ul>
      </div>

      <div className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-xl border border-border/60 bg-card p-4">
        {messages.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">Try one of these:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-foreground"
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
          className="h-11 flex-1 rounded-xl border border-border/60 bg-card px-4 text-sm outline-none focus:border-emerald-500/40"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="h-11 rounded-xl bg-emerald-500/90 px-5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </main>
  );
}
