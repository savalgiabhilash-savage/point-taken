import { createServerSupabase } from "@/lib/supabase/server";
import { isOwnerEmail } from "@/lib/owner";

/** True only for the signed-in owner account (gates the Docs tab and its content route). */
export async function isOwner(): Promise<boolean> {
  try {
    const sb = await createServerSupabase();
    const { data } = await sb.auth.getUser();
    return isOwnerEmail(data.user?.email);
  } catch {
    return false;
  }
}
