import Link from "next/link";
import { Scale } from "lucide-react";

/** "Compare" button for a player: opens the Compare page with him plus a suggested rival (same position,
 *  within £1m, highest projected; chosen on the Compare page). */
export function CompareLink({ playerId, className = "" }: { playerId: number; className?: string }) {
  return (
    <Link
      href={`/compare?p=${playerId}`}
      className={`press inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 font-display text-sm text-foreground hover:border-brand/60 ${className}`}
    >
      <Scale className="size-4" aria-hidden /> Compare
    </Link>
  );
}
