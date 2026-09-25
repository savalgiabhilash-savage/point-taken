import { createServerSupabase } from "@/lib/supabase/server";
import { isOwnerEmail } from "@/lib/owner";

/**
 * The user_id to scope personal data (team, optimizer) to: the logged-in user's uuid, or the
 * shared "me" demo squad when logged out. Until per-user RLS (9.3), logged-out visitors still see
 * the original single-user data so the app stays useful without an account.
 */
export async function currentUserId(): Promise<string> {
  try {
    const sb = await createServerSupabase();
    const { data } = await sb.auth.getUser();
    return data.user?.id ?? "me";
  } catch {
    return "me";
  }
}

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
