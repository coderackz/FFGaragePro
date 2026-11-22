/** Long lists come a page at a time: 300 unless asked for more (screens matching typed numbers ask for all, up to 10,000). */
export const PAGE = 300;
export const MAX_PAGE = 10_000;

export function pageLimit(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : PAGE;
}

/** Rows fetched with LIMIT limit + 1: the page, and whether there are more. */
export function page<T>(rows: T[], limit: number): { rows: T[]; more: boolean } {
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}
