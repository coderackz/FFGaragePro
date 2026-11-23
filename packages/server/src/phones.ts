import { phoneDigits } from "@ffgp/shared";

// A phone is found however it's written: 050 123 4567, 0501234567 or +971 50 123 4567.

/** SQL: `column` has the searched digits (`:digits`, from phoneSearch). */
export const phoneHas = (column: string) =>
  `(:digits IS NOT NULL AND replace(replace(replace(replace(replace(${column}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') LIKE :digits)`;

/** The `:digits` for a search text (null: too few digits to be a phone). */
export function phoneSearch(q: string | null | undefined): string | null {
  const digits = phoneDigits(q ?? "");
  return digits.length >= 4 ? `%${digits}%` : null;
}
