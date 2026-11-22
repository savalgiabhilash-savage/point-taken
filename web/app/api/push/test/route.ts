import webpush from "web-push";
import { createServerSupabase } from "@/lib/supabase/server";

// Send a test notification to every device this user turned notifications on for.
// Scheduled alerts (deadline, injuries) are sent by the worker (worker/fpl_worker/notify.py).
const clean = (v: string | undefined) => [...(v ?? "")].filter((c) => c.charCodeAt(0) !== 0xfeff).join("").trim();

export async function POST() {
  const pub = clean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
  const priv = clean(process.env.VAPID_PRIVATE_KEY);
  if (!pub || !priv) return Response.json({ error: "Notifications aren't configured on the server yet." }, { status: 503 });
  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });

  webpush.setVapidDetails("https://point-taken-fpl.vercel.app", pub, priv);
  const { data: subs } = await sb.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", auth.user.id);
  if (!subs?.length) return Response.json({ error: "Turn notifications on first." }, { status: 400 });

  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
        JSON.stringify({ title: "Point Taken", body: "Notifications are on. You'll get deadline reminders and injury alerts here.", url: "/team", tag: "test" }),
      );
      sent++;
    } catch (e) {
      // 404/410 = the browser dropped this subscription; forget it
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint as string);
    }
  }
  return sent ? Response.json({ ok: true, sent }) : Response.json({ error: "Couldn't reach this device; turn notifications off and on again." }, { status: 502 });
}
