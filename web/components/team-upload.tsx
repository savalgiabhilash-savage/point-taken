"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// Screenshot → team import. Posts the image to /api/team-upload (Claude Haiku 4.5 vision reads the
// 15 players + captain/bench and matches them to real players), then refreshes the page so a server
// component (e.g. My Team) re-renders with the freshly loaded squad. Shared by Settings and My Team.
export function TeamUpload({ title, note }: { title?: string; note?: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8_000_000) {
      setMsg("That image is over 8 MB — please use a smaller screenshot.");
      return;
    }
    setBusy(true);
    setMsg("Reading your team from the screenshot…");
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/team-upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const data = await res.json();
      if (data.ok) {
        const miss = (data.unmatched ?? []).length
          ? ` Couldn't match: ${(data.unmatched as string[]).join(", ")} — check the squad below and fix if needed.`
          : "";
        setMsg(`Loaded ${data.count} players into your team.${miss}`);
        router.refresh(); // re-render the server component so the new squad shows immediately
      } else {
        setMsg(data.error ?? "Couldn't read that screenshot — try a clearer one.");
      }
    } catch {
      setMsg("Upload failed — please retry.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      {title ? (
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</label>
      ) : null}
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={onFile}
        disabled={busy}
        className="hidden"
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="mt-3 h-11 w-full rounded-2xl border border-border bg-card text-sm font-medium transition-colors hover:border-brand/60 disabled:opacity-40"
      >
        {busy ? "Reading screenshot…" : "Choose screenshot"}
      </button>
      {msg ? <p className="mt-3 text-sm text-amber-500">{msg}</p> : null}
    </div>
  );
}
