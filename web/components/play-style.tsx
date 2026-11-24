"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "@/components/toast";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { GOALS, QUIZ, RISK, asGoal, asRisk, scoreQuiz, type Goal, type Risk } from "@/lib/play-style";

export async function savePlayStyle(body: { risk?: Risk; goal?: Goal | null; quiz?: boolean }) {
  const res = await fetch("/api/play-style", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; replanning?: boolean };
  if (!res.ok) throw new Error(data.error ?? "Couldn't save");
  return data;
}

/** The 5-question quiz, one question at a time, then the result. */
export function PlayStyleQuiz({ risk, goal, onSaved }: { risk: Risk; goal: Goal | null; onSaved?: () => void }) {
  const router = useRouter();
  const [step, setStep] = React.useState<number | null>(null); // null = not started
  const [answers, setAnswers] = React.useState<number[]>([]);
  const [busy, setBusy] = React.useState(false);
  const result = answers.length === QUIZ.length ? scoreQuiz(answers) : null;

  const save = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const r = await savePlayStyle({ risk: result.risk, goal: result.goal, quiz: true });
      toast(r.replanning ? `Saved · re-planning as ${RISK[result.risk].label} (~1–2 min)` : "Play style saved", "success");
      setStep(null);
      setAnswers([]);
      onSaved?.();
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", "error");
    }
    setBusy(false);
  };

  if (step === null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="space-y-0.5 text-sm">
          <li>
            • Style: <b>{RISK[risk].label}</b> <span className="text-muted-foreground">({RISK[risk].blurb})</span>
          </li>
          <li>
            • Goal: <b>{goal ? GOALS[goal].label : "not set"}</b>
          </li>
        </ul>
        <button
          type="button"
          onClick={() => setStep(0)}
          className="press rounded-md bg-grad px-3 py-2 text-xs font-bold uppercase tracking-wide"
        >
          Take the 5-question quiz
        </button>
      </div>
    );
  }

  if (result) {
    return (
      <div>
        <p className="text-sm">
          Your style: <b className="text-sky-300">{RISK[result.risk].label}</b>
          {result.goal ? (
            <>
              {" "}· goal: <b>{GOALS[result.goal].label}</b>
            </>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">• {RISK[result.risk].blurb}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={save} disabled={busy} className="press rounded-md bg-grad px-3 py-2 text-xs font-bold uppercase tracking-wide disabled:opacity-40">
            {busy ? "Saving…" : "Use this style"}
          </button>
          <button type="button" onClick={() => { setStep(0); setAnswers([]); }} className="rounded-md border border-border px-3 py-2 text-xs">
            Start again
          </button>
        </div>
      </div>
    );
  }

  const q = QUIZ[step];
  return (
    <div>
      <div className="mb-2 flex gap-1" aria-hidden>
        {QUIZ.map((_, i) => (
          <span key={i} className={`h-1 flex-1 rounded ${i <= step ? "bg-sky-400" : "bg-border"}`} />
        ))}
      </div>
      <p className="text-sm font-semibold">{q.q}</p>
      <div className="mt-2 grid gap-1.5">
        {q.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onClick={() => {
              const next = [...answers.slice(0, step), i];
              setAnswers(next);
              if (step < QUIZ.length - 1) setStep(step + 1);
            }}
            className="rounded-lg border border-border/70 px-3 py-2 text-left text-sm hover:border-sky-400/60 hover:bg-sky-400/5"
          >
            {o.label}
          </button>
        ))}
      </div>
      {step > 0 ? (
        <button type="button" onClick={() => setStep(step - 1)} className="mt-2 text-xs text-muted-foreground hover:text-foreground">
          ← Back
        </button>
      ) : null}
    </div>
  );
}

/** Safe · Balanced · Bold switch (Optimizer). Saving re-plans; onChange lets the caller follow the run. */
export function RiskSwitch({ value, disabled, onChanged }: { value: Risk; disabled?: boolean; onChanged: (r: Risk) => void }) {
  const [cur, setCur] = React.useState<Risk>(value);
  React.useEffect(() => setCur(value), [value]);
  return (
    <div role="radiogroup" aria-label="Risk profile" className="inline-flex rounded-lg border border-border p-0.5">
      {(Object.keys(RISK) as Risk[]).map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={cur === r}
          title={RISK[r].blurb}
          disabled={disabled}
          onClick={async () => {
            if (r === cur) return;
            const prev = cur;
            setCur(r);
            try {
              await savePlayStyle({ risk: r });
              onChanged(r);
            } catch (e) {
              setCur(prev);
              toast(e instanceof Error ? e.message : "Couldn't save", "error");
            }
          }}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
            cur === r ? "bg-sky-500/20 text-sky-200" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {RISK[r].label}
        </button>
      ))}
    </div>
  );
}

/** My Team: the goal with shortcuts to the right features, or (until the quiz is done) a dismissible prompt. */
export function GoalStrip({ goal, quizDone }: { goal: Goal | null; quizDone: boolean }) {
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    try {
      setHidden(localStorage.getItem("style-prompt-dismissed") === "1");
    } catch {
      // storage blocked: show the prompt
    }
  }, []);
  if (goal) {
    const g = GOALS[goal];
    return (
      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your goal</span>
        <span className="font-semibold">{g.label}</span>
        <span className="flex flex-wrap gap-1.5">
          {g.links.map((l) => (
            <Link key={l.href + l.label} href={l.href} className="rounded-md border border-sky-500/40 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/10">
              {l.label} →
            </Link>
          ))}
        </span>
        <Link href="/settings#play-style" className="ml-auto text-xs text-muted-foreground hover:text-foreground">
          Change
        </Link>
      </div>
    );
  }
  if (quizDone || hidden) return null;
  return (
    <div className="mt-5 flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 px-4 py-2.5 text-sm">
      <span className="flex-1">
        • Set your play style and goal: 5 quick questions, and the advice follows your appetite for risk
      </span>
      <Link href="/settings#play-style" className="press rounded-md bg-grad px-3 py-1.5 text-xs font-bold uppercase tracking-wide">
        Start
      </Link>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem("style-prompt-dismissed", "1");
          } catch {
            // ignore
          }
        }}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Settings → Play style: the current style and goal, and the quiz. */
export function PlayStyleSection({ userId }: { userId: string }) {
  const [p, setP] = React.useState<{ risk: Risk; goal: Goal | null } | null>(null);
  const load = React.useCallback(async () => {
    const { data } = await createBrowserSupabase().from("profiles").select("risk, goal").eq("id", userId).maybeSingle();
    setP({ risk: asRisk(data?.risk), goal: asGoal(data?.goal) });
  }, [userId]);
  React.useEffect(() => {
    void load();
  }, [load]);
  return (
    <section id="play-style" className="mt-6 scroll-mt-20 rounded-3xl border border-border bg-card p-5">
      <h2 className="font-display text-lg">Play style</h2>
      <ul className="mb-3 mt-1 space-y-0.5 text-xs text-muted-foreground">
        <li>• Sets how bold the Optimizer&apos;s transfers, captain and chips are, and the shortcuts on My Team</li>
        <li>• You can switch Safe / Balanced / Bold any time on the Optimizer</li>
      </ul>
      {p ? <PlayStyleQuiz risk={p.risk} goal={p.goal} onSaved={load} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </section>
  );
}
