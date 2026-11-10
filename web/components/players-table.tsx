"use client";

import * as React from "react";
import { PlayerInfo } from "@/components/player-info";
import { CompareLink } from "@/components/compare-link";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NewsSignal, PlayerRow, Position } from "@/lib/supabase";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const RIGHT = new Set(["price", "own", "last", "xp_next", "xp5"]);

const POS_PILL: Record<Position, string> = {
  GK: "bg-amber-400/15 text-amber-600 ring-amber-400/30 dark:text-amber-400",
  DEF: "bg-emerald-400/15 text-emerald-600 ring-emerald-400/30 dark:text-emerald-400",
  MID: "bg-sky-400/15 text-sky-600 ring-sky-400/30 dark:text-sky-400",
  FWD: "bg-rose-400/15 text-rose-600 ring-rose-400/30 dark:text-rose-400",
};

const STATUS: Record<string, { label: string; dot: string }> = {
  a: { label: "Available", dot: "bg-emerald-500" },
  d: { label: "Doubtful", dot: "bg-amber-500" },
  i: { label: "Injured", dot: "bg-red-500" },
  s: { label: "Suspended", dot: "bg-red-500" },
  u: { label: "Unavailable", dot: "bg-zinc-400" },
  n: { label: "Not in squad", dot: "bg-zinc-400" },
};

const price = (c: number | null) => (c == null ? "—" : `£${(c / 10).toFixed(1)}`);
const one = (v: number | null) => (v == null ? "—" : v.toFixed(1));

function fdrClasses(fdr: number | null): string {
  if (fdr == null) return "bg-muted text-muted-foreground";
  if (fdr < 2) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  if (fdr < 2.75) return "bg-lime-500/15 text-lime-700 dark:text-lime-400";
  if (fdr < 3.5) return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  if (fdr < 4.25) return "bg-orange-500/15 text-orange-700 dark:text-orange-400";
  return "bg-rose-500/15 text-rose-700 dark:text-rose-400";
}

// xPts heat chip — greener/darker as the projection rises.
function xpClasses(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 6) return "bg-emerald-600 text-white";
  if (v >= 4.5) return "bg-emerald-500/80 text-white";
  if (v >= 3) return "bg-emerald-500/45 text-emerald-950 dark:text-emerald-50";
  if (v >= 1.5) return "bg-emerald-500/20 text-foreground";
  return "bg-muted text-muted-foreground";
}

function PosPill({ pos }: { pos: Position | null }) {
  if (!pos) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${POS_PILL[pos]}`}
    >
      {pos}
    </span>
  );
}

// Advisory news chip — surface the single most decision-relevant topic (rank order),
// falling back to overall sentiment when the topics aren't availability-related.
const NEWS_STYLES: Record<string, { label: string; cls: string }> = {
  "injury-risk": { label: "injury", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400" },
  suspension: { label: "susp.", cls: "bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-400" },
  rotation: { label: "rotation", cls: "bg-amber-500/15 text-amber-600 ring-amber-500/30 dark:text-amber-400" },
  "return-from-injury": { label: "return", cls: "bg-sky-500/15 text-sky-600 ring-sky-500/30 dark:text-sky-400" },
  "form-buzz": { label: "buzz", cls: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400" },
  transfer: { label: "transfer", cls: "bg-violet-500/15 text-violet-600 ring-violet-500/30 dark:text-violet-400" },
  "off-pitch": { label: "news", cls: "bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-400" },
};
const NEWS_PRIORITY = [
  "injury-risk", "suspension", "rotation", "return-from-injury", "form-buzz", "transfer", "off-pitch",
];

function newsBadge(news: NewsSignal): { label: string; cls: string } {
  const topics = news.topics ?? [];
  for (const t of NEWS_PRIORITY) if (topics.includes(t)) return NEWS_STYLES[t];
  if (news.sentiment === "negative")
    return { label: "news", cls: "bg-amber-500/15 text-amber-600 ring-amber-500/30 dark:text-amber-400" };
  if (news.sentiment === "positive")
    return { label: "news", cls: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400" };
  return { label: "news", cls: "bg-zinc-500/15 text-zinc-600 ring-zinc-500/30 dark:text-zinc-400" };
}

function NewsChip({ news }: { news: NewsSignal }) {
  const b = newsBadge(news);
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${b.cls}`}
      title={news.summary ?? undefined}
    >
      {b.label}
    </span>
  );
}

const columns: ColumnDef<PlayerRow>[] = [
  {
    id: "web_name",
    accessorKey: "web_name",
    header: "Player",
    cell: (info) => {
      const r = info.row.original;
      return (
        <div className="flex flex-col leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{r.web_name}</span>
            <PlayerInfo playerId={r.fpl_id} name={r.web_name} />
            {r.news ? <NewsChip news={r.news} /> : null}
          </span>
          <span className="text-xs text-muted-foreground">{r.team?.short_name ?? ""}</span>
        </div>
      );
    },
  },
  {
    id: "position",
    accessorKey: "position",
    header: "Pos",
    cell: (info) => <PosPill pos={info.row.original.position} />,
  },
  {
    id: "price",
    accessorFn: (r) => r.now_cost ?? 0,
    header: "Price",
    cell: (info) => price(info.row.original.now_cost),
  },
  {
    id: "own",
    accessorFn: (r) => r.selected_by_percent ?? 0,
    header: "Own %",
    cell: (info) => one(info.row.original.selected_by_percent),
  },
  {
    id: "last",
    accessorFn: (r) => r.total_points ?? 0,
    header: "Last szn",
    cell: (info) => info.row.original.total_points ?? "—",
  },
  {
    id: "opp",
    accessorFn: (r) => r.opp_fdr ?? 3,
    header: "Opp",
    cell: (info) => {
      const r = info.row.original;
      if (!r.opp) return <span className="text-muted-foreground">—</span>;
      return (
        <span
          className={`inline-flex min-w-12 items-center justify-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${fdrClasses(r.opp_fdr)}`}
          title={r.opp_fdr != null ? `FDR ${r.opp_fdr.toFixed(1)}` : undefined}
        >
          {r.opp}
        </span>
      );
    },
  },
  {
    id: "xp_next",
    accessorFn: (r) => r.xp_next ?? -1,
    header: "xPts",
    cell: (info) => {
      const v = info.row.original.xp_next;
      return (
        <span
          className={`inline-flex min-w-12 items-center justify-center rounded-md px-2 py-1 text-sm font-semibold tabular-nums ${xpClasses(v)}`}
        >
          {v == null ? "—" : v.toFixed(1)}
        </span>
      );
    },
  },
  {
    id: "xp5",
    accessorFn: (r) => r.xp5 ?? -1,
    header: "Next 5",
    cell: (info) => (
      <span className="tabular-nums text-muted-foreground">
        {info.row.original.xp5 == null ? "—" : info.row.original.xp5.toFixed(1)}
      </span>
    ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: "",
    enableSorting: false,
    cell: (info) => {
      const s = STATUS[info.row.original.status ?? "a"] ?? STATUS.a;
      return <span className={`inline-block size-2.5 rounded-full ${s.dot}`} title={s.label} />;
    },
  },
];

const COMP_COLOR: Record<string, string> = {
  Appearance: "bg-zinc-400",
  Goals: "bg-emerald-500",
  Assists: "bg-sky-500",
  "Clean sheet": "bg-teal-500",
  Bonus: "bg-violet-500",
  DefCon: "bg-amber-500",
  Saves: "bg-cyan-500",
  Deductions: "bg-rose-500",
};

function PlayerDrawer({
  player,
  nextGw,
  onClose,
}: {
  player: PlayerRow | null;
  nextGw: number | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (player) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, onClose]);

  if (!player) return null;
  const comps = player.components ?? [];
  const positives = comps.filter((c) => c.value > 0.001);
  const totalPos = positives.reduce((s, c) => s + c.value, 0) || 1;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col gap-5 overflow-y-auto border-l border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{player.web_name}</span>
              <PlayerInfo playerId={player.fpl_id} name={player.web_name} />
              <PosPill pos={player.position} />
            </div>
            <div className="text-sm text-muted-foreground">
              {player.team?.name ?? ""} · {price(player.now_cost)} · {one(player.selected_by_percent)}% owned
            </div>
            <CompareLink playerId={player.fpl_id} className="mt-2" />
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums">{player.xp_next?.toFixed(1) ?? "—"}</span>
            <span className="text-sm text-muted-foreground">
              xPts{nextGw != null ? ` · GW${nextGw}` : ""}
              {player.opp ? ` ${player.opp}` : ""}
            </span>
          </div>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-muted">
            {positives.map((c) => (
              <div
                key={c.label}
                className={COMP_COLOR[c.label] ?? "bg-zinc-500"}
                style={{ width: `${(c.value / totalPos) * 100}%` }}
                title={`${c.label}: ${c.value.toFixed(2)}`}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          {comps.map((c) => (
            <div key={c.label} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${COMP_COLOR[c.label] ?? "bg-zinc-500"}`} />
                <span className={c.value < 0 ? "text-muted-foreground" : ""}>{c.label}</span>
              </span>
              <span className={`tabular-nums ${c.value < 0 ? "text-rose-400" : "text-foreground"}`}>
                {c.value >= 0 ? "+" : ""}
                {c.value.toFixed(2)}
              </span>
            </div>
          ))}
        </div>

        {player.schedule && player.schedule.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Next {player.schedule.length} fixtures
            </div>
            <div className="flex gap-1.5">
              {player.schedule.map((s) => (
                <div key={s.gw} className="flex flex-1 flex-col items-center gap-1">
                  <span
                    className={`w-full rounded px-1 py-1 text-center text-[11px] font-medium ${fdrClasses(s.fdr)}`}
                  >
                    {s.opp?.replace(/^v /, "") ?? "—"}
                  </span>
                  <span className="text-[11px] font-semibold tabular-nums">{s.xp.toFixed(1)}</span>
                  <span className="text-[9px] text-muted-foreground">GW{s.gw}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {player.news && (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              News &amp; sentiment
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <NewsChip news={player.news} />
                {(player.news.topics ?? [])
                  .filter((t) => t !== "none")
                  .map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
              </div>
              {player.news.summary ? (
                <p className="mt-2 text-sm leading-snug">{player.news.summary}</p>
              ) : null}
              {player.news.minutes_risk_adj != null && player.news.minutes_risk_adj < 0 ? (
                <div className="mt-2 text-xs text-amber-500">
                  Minutes risk {Math.round(player.news.minutes_risk_adj * 100)}%
                  <span className="text-muted-foreground"> · advisory, not in xPts</span>
                </div>
              ) : null}
              {player.news.url ? (
                <a
                  href={player.news.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-emerald-500 hover:underline"
                >
                  {player.news.source ?? "Source"} ↗
                </a>
              ) : null}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

// Rendering all ~670 rows made the page ~1.7 MB of HTML; show the top rows first (sort and filters still use all).
const FIRST_ROWS = 100;

export function PlayersTable({ players, nextGw }: { players: PlayerRow[]; nextGw: number | null }) {
  const [selected, setSelected] = React.useState<PlayerRow | null>(null);
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "xp_next", desc: true }]);
  const [pos, setPos] = React.useState("ALL");
  const [team, setTeam] = React.useState("ALL");
  const [maxPrice, setMaxPrice] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);

  const teams = React.useMemo(
    () =>
      Array.from(
        new Set(players.map((p) => p.team?.short_name).filter(Boolean) as string[]),
      ).sort(),
    [players],
  );

  const data = React.useMemo(() => {
    const max = parseFloat(maxPrice);
    const q = search.trim().toLowerCase();
    return players.filter((p) => {
      if (pos !== "ALL" && p.position !== pos) return false;
      if (team !== "ALL" && p.team?.short_name !== team) return false;
      if (!Number.isNaN(max) && (p.now_cost ?? 0) > max * 10) return false;
      if (
        q &&
        !p.web_name.toLowerCase().includes(q) &&
        !(p.team?.name ?? "").toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [players, pos, team, maxPrice, search]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search player or team…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-56"
        />
        <Select value={pos} onValueChange={setPos}>
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue placeholder="Position">{pos === "ALL" ? "All positions" : pos}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All positions</SelectItem>
            {POSITIONS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="h-9 w-[130px]">
            <SelectValue placeholder="Team">{team === "ALL" ? "All teams" : team}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All teams</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          inputMode="decimal"
          step="0.1"
          placeholder="Max £"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          className="h-9 w-24"
        />
        <span className="ml-auto text-sm text-muted-foreground">
          {data.length} of {players.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {/* Scrolls inside its own box (about one screen tall) so the header row can stay pinned. */}
        <Table containerClassName="max-h-[calc(100dvh-11rem)] overflow-auto overscroll-contain">
          <TableHeader className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const label =
                    header.column.id === "opp" && nextGw != null ? `Opp (GW${nextGw})` : null;
                  return (
                    <TableHead
                      key={header.id}
                      className={`bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground ${
                        RIGHT.has(header.column.id) ? "text-right" : ""
                      }`}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={`inline-flex items-center gap-1 hover:text-foreground ${
                            RIGHT.has(header.column.id) ? "flex-row-reverse" : ""
                          }`}
                        >
                          {label ?? flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="text-[10px]">
                            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                          </span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.slice(0, showAll ? undefined : FIRST_ROWS).map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer border-border/40"
                  onClick={() => setSelected(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`py-2 ${RIGHT.has(cell.column.id) ? "text-right tabular-nums" : ""}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No players match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {!showAll && table.getRowModel().rows.length > FIRST_ROWS && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full rounded-lg border border-border/60 py-2 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          Show all {table.getRowModel().rows.length} players
        </button>
      )}

      <PlayerDrawer player={selected} nextGw={nextGw} onClose={() => setSelected(null)} />
    </div>
  );
}
