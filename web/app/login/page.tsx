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

  // Coming back from a failed Google sign-in (/auth/callback sends ?error=google).
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") !== "google") return;
    const t = setTimeout(() => setMsg("Google sign-in didn't finish. Please try again."), 0);
    return () => clearTimeout(t);
  }, []);

  // Google sign-in: Supabase sends the user to Google, then back to /auth/callback, which sets the session.
  const google = async () => {
    setLoading(true);
    setMsg(null);
    const { error } = await createBrowserSupabase().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/team` },
    });
    if (error) {
      setMsg(error.message);
      setLoading(false);
    }
  };

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

      <button
        type="button"
        onClick={google}
        disabled={loading}
        className="press mt-6 flex h-11 w-full items-center justify-center gap-3 rounded-md border border-border bg-white text-sm font-semibold text-[#1f1f1f] hover:bg-zinc-50 disabled:opacity-40"
      >
        <GoogleG />
        Continue with Google
      </button>

      <div className="mt-5 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or with email
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={submit} className="mt-5 space-y-3">
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

/** Google's standard four-colour "G" (required on Google sign-in buttons). */
function GoogleG() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="size-5">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
