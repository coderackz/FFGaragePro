import type { LineKind } from "./schemas";

/** What a line's quantity counts (the unit box on a document line suggests these; any short text is allowed). */
export const UNIT_SUGGESTIONS = ["Pc", "Set", "Pair", "Box", "Litre", "Kg", "Metre", "Hr", "Job"] as const;

/** A new line's unit: labour in hours, other work by the piece, a linked part in its own unit ("each" reads Pc). */
export function defaultUnit(kind: LineKind, partUnit?: string | null): string {
  if (kind === "labour") return "Hr";
  if (kind === "part" && partUnit && partUnit.toLowerCase() !== "each") return partUnit;
  return "Pc";
}
