"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { PageHeader } from "@/components/shell";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<"signin" | "signup">("signin");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setMsg(null);
    const sb = createBrowserSupabase();
    try {
      if (mode === "signup") {
        const { error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Account created. If email confirmation is on, check your inbox — otherwise sign in now.");
        setMode("signin");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/players");
        router.refresh();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col px-4 py-16 sm:px-6">
      <PageHeader title={<>{mode === "signin" ? "Log in" : "Create account"}</>} />
      <p className="mt-1 text-sm text-muted-foreground">
        {mode === "signin" ? "Sign in to see your team and personalised picks." : "Sign up to track your own FPL team."}
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="h-11 w-full rounded-2xl border border-border bg-card px-4 text-base outline-none sm:text-sm focus:border-brand/60"
        />
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min 6 characters)"
          className="h-11 w-full rounded-2xl border border-border bg-card px-4 text-base outline-none sm:text-sm focus:border-brand/60"
        />
        <button
          type="submit"
          disabled={loading}
          className="h-11 w-full press rounded-md bg-grad glow text-sm font-bold uppercase tracking-wide hover:brightness-110 disabled:opacity-40"
        >
          {loading ? "…" : mode === "signin" ? "Log in" : "Sign up"}
        </button>
      </form>

      {msg && <p className="mt-3 text-sm text-amber-500">{msg}</p>}

      <button
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setMsg(null);
        }}
        className="mt-4 text-sm text-muted-foreground hover:text-foreground"
      >
        {mode === "signin" ? "Need an account? Sign up" : "Have an account? Log in"}
      </button>
    </main>
  );
}
