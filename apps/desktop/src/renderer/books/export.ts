import writeXlsxFile from "write-excel-file/browser";
import { printHtml } from "../print/print";

export interface ExportColumn { header: string; key: string; money?: boolean; width?: number }
export interface ExportSheet { title: string; subtitle?: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }

const escape = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const aed = (fils: number) => (fils / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A report as an Excel file (money as numbers in AED with 2 decimals, so the accountant can add them up). */
export async function exportXlsx(fileName: string, sheet: ExportSheet): Promise<void> {
  const header = sheet.columns.map((c) => ({ value: c.header, fontWeight: "bold" as const }));
  const rows = sheet.rows.map((r) =>
    sheet.columns.map((c) => {
      const v = r[c.key];
      if (c.money) return typeof v === "number" ? { value: v / 100, type: Number, format: "#,##0.00" } : null;
      return v === null || v === undefined ? null : { value: String(v), type: String };
    }),
  );
  const data = [[{ value: sheet.title, fontWeight: "bold" as const }], ...(sheet.subtitle ? [[{ value: sheet.subtitle }]] : []), [], header, ...rows];
  const blob = await writeXlsxFile(data as never, { columns: sheet.columns.map((c) => ({ width: c.width ?? (c.money ? 14 : 30) })) }).toBlob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** The same report as a printable A4 page (saved as PDF on a PC, printed from the browser). */
export function exportPdf(garageName: string, sheet: ExportSheet): Promise<void> {
  const head = sheet.columns.map((c) => `<th${c.money ? ' class="n"' : ""}>${escape(c.header)}</th>`).join("");
  const body = sheet.rows
    .map((r) => `<tr>${sheet.columns.map((c) => (c.money ? `<td class="n">${typeof r[c.key] === "number" ? aed(r[c.key] as number) : ""}</td>` : `<td>${escape(r[c.key])}</td>`)).join("")}</tr>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(sheet.title)}</title><style>
    @page { size: A4; margin: 14mm; } body { font-family: "Segoe UI", -apple-system, Arial, sans-serif; font-size: 9.5pt; color: #18181b; }
    h1 { font-size: 15pt; margin: 0 0 1mm; } .sub { color: #52525b; margin-bottom: 5mm; } table { width: 100%; border-collapse: collapse; }
    th { text-align: left; border-bottom: 1px solid #a1a1aa; padding: 1.5mm 1mm; font-size: 8.5pt; } td { padding: 1.2mm 1mm; border-bottom: 1px solid #e4e4e7; }
    .n { text-align: right; font-variant-numeric: tabular-nums; } tr:last-child td { font-weight: 600; }
  </style></head><body><div class="sub">${escape(garageName)}</div><h1>${escape(sheet.title)}</h1>${sheet.subtitle ? `<div class="sub">${escape(sheet.subtitle)}</div>` : ""}
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
  return printHtml(html, `${sheet.title}${sheet.subtitle ? ` ${sheet.subtitle}` : ""}`, "pdf");
}
