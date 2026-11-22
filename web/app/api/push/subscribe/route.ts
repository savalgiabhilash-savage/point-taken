import { createServerSupabase } from "@/lib/supabase/server";

// Save (POST) or remove (DELETE) this device's push subscription, with the user's choices.
// RLS keeps each user to their own rows.
type Body = { subscription?: { endpoint: string; keys: { p256dh: string; auth: string } }; endpoint?: string; deadline?: boolean; injuries?: boolean };

export async function POST(req: Request) {
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Body;
  const s = b.subscription;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) return Response.json({ error: "Invalid subscription." }, { status: 400 });
  const { error } = await sb.from("push_subscriptions").upsert(
    { user_id: auth.user.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, deadline: b.deadline ?? true, injuries: b.injuries ?? true },
    { onConflict: "endpoint" },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Body;
  if (!b.endpoint) return Response.json({ error: "Missing endpoint." }, { status: 400 });
  await sb.from("push_subscriptions").delete().eq("endpoint", b.endpoint).eq("user_id", auth.user.id);
  return Response.json({ ok: true });
}
