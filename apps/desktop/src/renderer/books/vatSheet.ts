import type { ExportSheet } from "./export";

export interface VatRow { entryId: string; number: string; date: string; narration: string; amountFils: number; vatFils: number; adjustmentFils: number; originalDate: string | null }
export interface VatBox { key: string; label: string; amountFils: number; vatFils: number; adjustmentFils: number; rows: VatRow[] }
export interface VatSheetFigures { from: string; to: string; boxes: VatBox[]; dueFils: number; recoverableFils: number; payableFils: number }

const fmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => fmt.format(new Date(`${ymd}T00:00:00Z`));

/** The VAT return as a sheet: every box, then boxes 12–14, then the entries behind each box (for the accountant). */
export function vatSheet(f: VatSheetFigures, filed: { filedAt: string | null; reference: string | null }): ExportSheet {
  const refund = f.payableFils < 0;
  return {
    title: `VAT return ${day(f.from)} – ${day(f.to)}`,
    subtitle: filed.filedAt ? `Filed ${day(filed.filedAt.slice(0, 10))}${filed.reference ? `, reference ${filed.reference}` : ""}` : "Not filed",
    columns: [
      { header: "Box", key: "box", width: 8 }, { header: "Entry", key: "entry", width: 12 }, { header: "Date", key: "date", width: 14 },
      { header: "Description", key: "label", width: 44 }, { header: "Amount", key: "amount", money: true }, { header: "VAT", key: "vat", money: true },
      { header: "Adjustment", key: "adj", money: true },
    ],
    rows: [
      ...f.boxes.map((b) => ({ box: b.key, label: b.label, amount: b.amountFils, vat: b.vatFils, adj: b.adjustmentFils })),
      { box: "12", label: "Total value of due tax for the period", vat: f.dueFils },
      { box: "13", label: "Total value of recoverable tax for the period", vat: f.recoverableFils },
      { box: "14", label: refund ? "Refundable tax for the period" : "Payable tax for the period", vat: Math.abs(f.payableFils) },
      ...f.boxes.flatMap((b) => b.rows.map((r) => ({
        box: b.key, entry: r.number, date: day(r.date), label: r.originalDate ? `${r.narration} (dated ${day(r.originalDate)})` : r.narration,
        amount: r.amountFils, vat: r.vatFils, adj: r.adjustmentFils,
      }))),
    ],
  };
}
