"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Search, Sparkles, X } from "lucide-react";
import { suggest, taskLabel, type Task } from "@/lib/command";
import { toast } from "@/components/toast";

// "Type what you want": a box on every screen (Ctrl+K or / opens it). Pages matching what's typed are
// suggested instantly; anything else goes to /api/command, which opens the page that shows it (pre-set
// where possible), offers a task to confirm, or answers right here.

const EXAMPLES = ["Compare Saka and Palmer", "Arsenal's form", "Easiest fixtures for defenders", "Who should I captain?", "Re-optimize over 5 GWs", "Switch to Bold"];
type Result = { answer?: string | null; task?: Task; error?: string };

export function CommandButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = React.useState(false);
  // Only the sidebar copy listens for the shortcut (both copies are mounted; CSS hides one), so it opens once.
  React.useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact]);
  return (
    <>
      {compact ? (
        <button type="button" aria-label="Type what you want" onClick={() => setOpen(true)} className="press flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <Search className="size-5" />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="press flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground hover:text-foreground">
          <Search className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left">Type what you want…</span>
          <kbd className="rounded border border-border px-1 text-[10px]">Ctrl K</kbd>
        </button>
      )}
      {/* Portal: the sidebar is a sticky stacking context, so the dialog must render at the body to sit on top. */}
      {open && createPortal(<CommandDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function CommandDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<Result | null>(null);
  const [asked, setAsked] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sugg = suggest(q);
  const strong = sugg[0]?.strong ?? false;
  // The rows: a strong page match first (Enter goes there), otherwise "Ask" first.
  type Row = { kind: "page"; href: string; label: string; desc: string } | { kind: "ask" };
  const pages: Row[] = sugg.map((s) => ({ kind: "page", href: s.dest.href, label: s.dest.label, desc: s.dest.desc }));
  const rows: Row[] = q.trim() ? (strong ? [...pages, { kind: "ask" }] : [{ kind: "ask" }, ...pages]) : [];

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setRes(null);
    setAsked(text.trim());
    try {
      const r = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: text }) });
      const data = (await r.json()) as Result & { open?: string };
      if (data.open) {
        if (data.answer) toast(data.answer);
        go(data.open);
        return;
      }
      setRes(data);
    } catch {
      setRes({ error: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  const pick = (row: Row) => (row.kind === "page" ? go(row.href) : ask(q));

  const runTask = async (t: Task) => {
    const label = taskLabel(t);
    toast(`${label}…`, "loading", "command-task");
    onClose();
    try {
      const r =
        t.kind === "reoptimize"
          ? await fetch("/api/optimize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ horizon: t.horizon }) })
          : t.kind === "set_risk"
            ? await fetch("/api/play-style", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ risk: t.risk }) })
            : await fetch("/api/sync", { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(data.error ?? "That didn't work. Please try again.", "error", "command-task");
        return;
      }
      if (t.kind === "sync_team") {
        toast("Team synced", "success", "command-task");
        router.refresh();
      } else {
        toast(`${t.kind === "reoptimize" ? "Optimizing" : "Re-planning"} in the cloud · ~1–2 min. Reload Transfers to see it.`, "success", "command-task");
        router.push("/optimizer");
      }
    } catch {
      toast("Network error. Please try again.", "error", "command-task");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Type what you want" className="rise w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (rows[active]) pick(rows[active]);
          }}
          className="flex items-center gap-2 border-b border-border px-4"
        >
          {busy ? <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" /> : <Search className="size-5 shrink-0 text-muted-foreground" />}
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            }}
            placeholder="What do you want to see or do?"
            className="h-14 flex-1 bg-transparent text-base outline-none"
          />
          <button type="button" aria-label="Close" onClick={onClose} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </form>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {rows.map((row, i) => (
            <button
              key={row.kind === "page" ? row.href : "ask"}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(row)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${active === i ? "bg-accent" : ""}`}
            >
              {row.kind === "page" ? (
                <>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{row.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{row.desc}</span>
                  </span>
                </>
              ) : (
                <>
                  <Sparkles className="size-4 shrink-0 text-sky-300" />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">Ask Point Taken: </span>
                    <span className="text-muted-foreground">&ldquo;{q.trim()}&rdquo;</span>
                    <span className="block text-xs text-muted-foreground">Opens the page that shows it, does the task, or answers here</span>
                  </span>
                </>
              )}
              {active === i ? <kbd className="rounded border border-border px-1 text-[10px] text-muted-foreground">Enter</kbd> : null}
            </button>
          ))}

          {!q.trim() && !res ? (
            <div className="px-3 py-2">
              <p className="text-xs text-muted-foreground">Try:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {EXAMPLES.map((x) => (
                  <button key={x} type="button" onClick={() => { setQ(x); ask(x); }} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
                    {x}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {res ? (
            <div className="mt-1 rounded-xl border border-border bg-background/60 px-4 py-3 text-sm">
              <p className="text-xs text-muted-foreground">&ldquo;{asked}&rdquo;</p>
              {res.error ? <p className="mt-1 text-rose-300">{res.error}</p> : null}
              {res.answer ? <p className="mt-1 whitespace-pre-wrap leading-relaxed">{bold(res.answer)}</p> : null}
              {res.task ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{taskLabel(res.task)}?</span>
                  <button type="button" onClick={() => runTask(res.task!)} className="press rounded-md bg-grad glow px-4 py-1.5 text-xs font-bold uppercase tracking-wide">
                    Do it
                  </button>
                  <button type="button" onClick={() => setRes(null)} className="text-xs text-muted-foreground hover:text-foreground">
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The answer's **bold** markdown as bold text (the only markdown answers use here). */
const bold = (t: string) => t.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
