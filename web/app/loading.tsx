// Shown on every navigation while the page's data loads on the server: a thin top progress bar at once, and a
// skeleton that fades in only after 150 ms so fast loads don't flicker.
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8" aria-busy="true">
      <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden">
        <div className="load-bar h-full w-2/5 bg-grad" />
      </div>
      <div className="late">
        <div role="status" className="flex h-[124px] items-center gap-3 rounded-3xl border border-border bg-card px-5 text-sm text-muted-foreground">
          <span className="size-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Loading…
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-2xl border border-border bg-muted/40" />
          ))}
        </div>
        <div className="mt-6 h-96 animate-pulse rounded-3xl border border-border bg-muted/30" />
      </div>
    </main>
  );
}
