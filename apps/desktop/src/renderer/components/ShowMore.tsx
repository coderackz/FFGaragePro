import { useEffect, useState } from "react";
import { Button } from "./ui";

/** Lists come 300 at a time; "Show more" asks for 300 more. A new search or filter (`resetKey`) starts again at 300. */
export const PAGE = 300;
/** Screens that match a typed part number or name against the whole list ask for all of it. */
export const ALL = 10_000;

export function usePageLimit(resetKey: string): [number, () => void] {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [resetKey]);
  return [limit, () => setLimit((l) => l + PAGE)];
}

export function ShowMore({ more, loading, shown, onMore }: { more: boolean | undefined; loading: boolean; shown: number; onMore: () => void }) {
  if (!more) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t border-zinc-100 px-4 py-3 text-sm text-zinc-500">
      <span>Showing the first {shown}</span>
      <Button onClick={onMore} busy={loading}>Show more</Button>
    </div>
  );
}
