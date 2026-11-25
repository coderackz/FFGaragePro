import type { DocLine } from "./types";

/** A line counts (gets a number and is saved) once it has a title or a price; blank lines are dropped. */
export const lineCounts = (l: DocLine) => l.description.trim() !== "" || l.unitPriceFils > 0;

/** The lines as they're sent to the server: blank ones dropped, text tidied. */
export const sentLines = (lines: DocLine[]) =>
  lines.filter(lineCounts).map((l) => {
    // A used part is bought for the job: never from the parts list, never Fleet Fix's.
    const used = l.kind === "part" && l.condition === "used";
    return { ...l, condition: used ? "used" as const : "new" as const, ...(used ? { partId: null, suppliedBy: "garage" as const } : {}) };
  }).map(({ kind, description, details, unit, qty, unitPriceFils, discountPct, partId, suppliedBy, poLineId, unitIds, condition }) => ({
    kind, description: description.trim(), qty, unitPriceFils, discountPct, condition,
    details: kind === "part" || !details?.trim() ? null : details.replace(/\s+$/, ""), unit: unit?.trim() || null,
    partId: kind === "part" ? partId ?? null : null, suppliedBy: kind === "part" ? suppliedBy ?? "garage" as const : "garage" as const, poLineId: poLineId ?? null,
    // More tyres picked than the quantity (it was lowered): the first ones picked are kept.
    unitIds: kind === "part" && partId && (suppliedBy ?? "garage") === "garage" ? (unitIds ?? []).slice(0, Math.max(0, Math.floor(qty))) : [],
  }));

/**
 * The server's copy of the lines on screen brought in without touching what's being typed: the text boxes keep their
 * spaces and new lines, and lines not typed in yet stay; everything else (ids, figures, orders) is the server's.
 * Null when the saved lines aren't the ones on screen (someone else's change).
 */
export function mergeSavedLines(onScreen: DocLine[], saved: DocLine[]): DocLine[] | null {
  // The server owns a line's link to a purchase order, so it isn't compared.
  const same = (lines: DocLine[]) => JSON.stringify(sentLines(lines).map(({ poLineId: _, ...l }) => l));
  if (same(onScreen) !== same(saved)) return null;
  let next = 0;
  return onScreen.map((l) => (lineCounts(l) ? { ...saved.filter(lineCounts)[next++]!, description: l.description, details: l.details, unit: l.unit } : l));
}

/** A text box the server saved without its outer spaces keeps what's typed in it. */
export const keepTyped = (typed: string, saved: string): string => (typed.trim() === saved.trim() ? typed : saved);
