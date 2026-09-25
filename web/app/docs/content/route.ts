import { readFile } from "node:fs/promises";
import path from "node:path";
import { isOwner } from "@/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves web/content/architecture.html (the same file published as the Claude artifact) to the owner
// only. The file is an artifact-style fragment, so wrap it in a full document; the app is dark-only.
export async function GET() {
  if (!(await isOwner())) return new Response("Not found", { status: 404 });
  const body = await readFile(path.join(process.cwd(), "content", "architecture.html"), "utf8");
  const html =
    '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>' +
    body +
    "</body></html>";
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}
