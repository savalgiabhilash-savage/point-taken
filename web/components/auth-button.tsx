"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

export function AuthButton() {
  const router = useRouter();
  const [email, setEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    const sb = createBrowserSupabase();
    sb.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => setEmail(session?.user?.email ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await createBrowserSupabase().auth.signOut();
    setEmail(null);
    router.push("/players");
    router.refresh();
  };

  if (email) {
    return (
      <div className="ml-auto flex items-center gap-3 text-sm">
        <span className="max-w-[160px] truncate text-muted-foreground">{email}</span>
        <button
          onClick={signOut}
          className="rounded-md px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <Link
      href="/login"
      className="ml-auto rounded-md bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
    >
      Log in
    </Link>
  );
}
