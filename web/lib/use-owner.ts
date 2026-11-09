"use client";

import * as React from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isOwnerEmail } from "@/lib/owner";

/** True when the signed-in user is the owner (shows the Docs page in the nav). */
export function useOwner() {
  const [owner, setOwner] = React.useState(false);
  React.useEffect(() => {
    const sb = createBrowserSupabase();
    sb.auth.getUser().then(({ data }) => setOwner(isOwnerEmail(data.user?.email)));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => setOwner(isOwnerEmail(session?.user?.email)));
    return () => sub.subscription.unsubscribe();
  }, []);
  return owner;
}
