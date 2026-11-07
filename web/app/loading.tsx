// Shown instantly on every navigation while the page's data loads on the server.
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8" aria-busy="true">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="size-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        Loading…
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[68px] animate-pulse rounded-xl border border-border/60 bg-muted/40" />
        ))}
      </div>
      <div className="mt-6 h-96 animate-pulse rounded-xl border border-border/60 bg-muted/30" />
    </main>
  );
}
