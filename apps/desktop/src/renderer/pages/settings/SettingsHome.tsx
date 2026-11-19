import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { PageHeader, Spinner } from "../../components/ui";
import { GROUP_LABELS, gettingReady, READY_SECTION, TILES, type TileContext, type TileGroup, type Tone } from "./tiles";
import { useTileContext } from "./useTileContext";

const TONE: Record<Tone, string> = {
  ok: "text-emerald-700",
  todo: "text-amber-700",
  alert: "text-red-700",
  muted: "text-zinc-500",
};
const DOT: Record<Tone, string> = { ok: "bg-emerald-500", todo: "bg-amber-500", alert: "bg-red-500", muted: "bg-zinc-300" };

/** Settings home: a tile per section, each saying how it stands, grouped. */
export function SettingsHome() {
  const ctx = useTileContext();
  if (!ctx) return <Spinner />;
  const groups = Object.keys(GROUP_LABELS) as TileGroup[];
  return (
    <>
      <PageHeader title="Settings" subtitle="Everything about your garage and how the app works" />
      <GettingReady ctx={ctx} />
      {groups.map((g) => {
        const tiles = TILES.filter((t) => t.group === g && t.show(ctx));
        if (!tiles.length) return null;
        return (
          <section key={g} className="mb-6">
            <h2 className="mb-2 text-xs font-semibold tracking-wider text-zinc-600 uppercase">{GROUP_LABELS[g]}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {tiles.map((t) => {
                const s = t.status(ctx);
                const body = (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-semibold text-zinc-900">{t.title}</div>
                      {!t.coming && <ChevronRight className="mt-0.5 size-4 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-700" />}
                    </div>
                    <div className="mt-0.5 text-sm text-zinc-600">{t.blurb}</div>
                    <div className={clsx("mt-3 flex items-center gap-1.5 text-sm font-medium", TONE[s.tone])}>
                      <span className={clsx("size-1.5 rounded-full", DOT[s.tone])} aria-hidden />
                      {s.text}
                    </div>
                  </>
                );
                return t.coming ? (
                  <div key={t.id} className="rounded-lg border border-dashed border-zinc-300 bg-white/60 p-4 opacity-70" aria-disabled>
                    {body}
                  </div>
                ) : (
                  <Link
                    key={t.id}
                    to={`/settings/${t.id}`}
                    className="group rounded-lg border border-zinc-200 bg-white p-4 shadow-xs transition hover:border-zinc-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-brand"
                    data-testid={`tile-${t.id}`}
                  >
                    {body}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

function GettingReady({ ctx }: { ctx: TileContext }) {
  const ready = gettingReady(ctx);
  if (ready.done === ready.total) return null;
  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4" data-testid="getting-ready">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="font-semibold text-zinc-900">Getting ready</div>
        <div className="text-sm text-zinc-600">{ready.done} of {ready.total} done</div>
        <div className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-zinc-100">
          <div className="h-full rounded-full bg-zinc-900" style={{ width: `${(ready.done / ready.total) * 100}%` }} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <span className="text-zinc-600">Still to add:</span>
        {ready.missing.map((m) => (
          <Link key={m} to={`/settings/${READY_SECTION[m] ?? ""}`} className="rounded-full bg-amber-50 px-2.5 py-0.5 text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100">
            {m}
          </Link>
        ))}
      </div>
    </div>
  );
}
