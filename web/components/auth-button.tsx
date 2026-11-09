"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Settings, FileText, LogOut, LogIn } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isOwnerEmail } from "@/lib/owner";

// Account menu: avatar button that opens Settings, Docs (owner only; /docs is gated server-side) and Sign out.
// Signed out, it is a Log in button. placement: "top" = phone header (menu drops down), "side" = sidebar foot.
export function AccountMenu({ placement }: { placement: "top" | "side" }) {
  const router = useRouter();
  const path = usePathname();
  const [email, setEmail] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [prev, setPrev] = React.useState(path);
  if (prev !== path) { setPrev(path); setOpen(false); } // close after navigating

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

  const row = "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm hover:bg-accent";

  if (!email) {
    return (
      <div className={placement === "side" ? "space-y-1" : "flex items-center gap-1"}>
        <Link href="/login" className={`press inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-md bg-grad px-4 text-sm font-bold uppercase tracking-wide glow ${placement === "side" ? "w-full justify-center" : ""}`}>
          <LogIn className="size-4" aria-hidden /> Log in
        </Link>
        <Link href="/settings" aria-label="Settings" className={placement === "side" ? `${row} text-muted-foreground` : "flex size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"}>
          <Settings className="size-4" aria-hidden />{placement === "side" && "Settings"}
        </Link>
      </div>
    );
  }

  const initial = email[0]?.toUpperCase() ?? "?";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        className={placement === "side" ? `${row} text-left` : "flex size-10 items-center justify-center"}
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-grad text-sm font-bold">{initial}</span>
        {placement === "side" && <span className="min-w-0 flex-1 truncate text-muted-foreground">{email}</span>}
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            className={`rise absolute z-50 w-60 rounded-2xl border border-border bg-popover p-1.5 shadow-xl ${
              placement === "side" ? "bottom-full left-0 mb-2" : "right-0 top-full mt-2"
            }`}
          >
            <p className="truncate px-3 py-2 text-xs text-muted-foreground">{email}</p>
            <Link href="/settings" className={row}><Settings className="size-4" aria-hidden />Settings</Link>
            {isOwnerEmail(email) && <Link href="/docs" className={row}><FileText className="size-4" aria-hidden />Docs</Link>}
            <button type="button" onClick={signOut} className={row}><LogOut className="size-4" aria-hidden />Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}
