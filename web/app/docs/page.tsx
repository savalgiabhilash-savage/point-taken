import { notFound } from "next/navigation";
import { isOwner } from "@/lib/current-user";

export const dynamic = "force-dynamic";

// Owner-only blueprint. Anyone else gets a 404 so the page's existence isn't revealed.
// The HTML itself is served by ./content/route.ts (same gate) and framed here under the app header.
export default async function DocsPage() {
  if (!(await isOwner())) notFound();
  return (
    <iframe
      src="/docs/content"
      title="FPL Selector Blueprint"
      className="block h-[calc(100vh-3.5rem)] w-full border-0"
    />
  );
}
