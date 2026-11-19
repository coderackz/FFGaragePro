import type { DocLanguage } from "@ffgp/shared";
import regular from "@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-400-normal.woff2?inline";
import bold from "@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-700-normal.woff2?inline";

/**
 * Noto Naskh Arabic (SIL Open Font License 1.1), embedded so printing, PDFs and the Settings preview draw Arabic the
 * same way on every PC and browser, offline. Only English + Arabic pages include it.
 */
export const ARABIC_FONT_CSS = `
  @font-face { font-family: "Noto Naskh Arabic"; font-weight: 400; font-style: normal; src: url(${regular}) format("woff2"); }
  @font-face { font-family: "Noto Naskh Arabic"; font-weight: 700; font-style: normal; src: url(${bold}) format("woff2"); }
  body { font-family: "Segoe UI", -apple-system, Arial, "Noto Naskh Arabic", sans-serif; }
  [lang="ar"] { font-family: "Noto Naskh Arabic", "Segoe UI", Arial, sans-serif; }
  .ar-block { direction: rtl; text-align: right; margin-top: 1.5mm; }
  .ar-block .name { font-size: 14pt; font-weight: 700; color: #18181b; }
  .arl { direction: rtl; text-align: right; color: #3f3f46; font-size: 9.5pt; margin-top: 0.5mm; }
  .words { margin-top: 3mm; font-size: 9pt; color: #3f3f46; }
  .words[dir="rtl"] { margin-top: 1mm; font-size: 10pt; }
`;

/** Arabic for every printed label. Labels with no entry print in English only. */
const AR: Record<string, string> = {
  "Bill to": "فاتورة إلى",
  Customer: "العميل",
  Vehicle: "المركبة",
  Description: "الوصف",
  Qty: "الكمية",
  "Unit price": "سعر الوحدة",
  "Unit price (incl. VAT)": "سعر الوحدة شامل الضريبة",
  "Disc.": "الخصم",
  Amount: "المبلغ",
  Total: "المجموع",
  "Subtotal (excl. VAT)": "المجموع قبل الضريبة",
  "Total (AED, incl. VAT)": "الإجمالي شامل الضريبة",
  "Total credit (AED, incl. VAT)": "إجمالي الإشعار شامل الضريبة",
  Credited: "المبلغ المعاد",
  Paid: "المدفوع",
  "Balance due": "الرصيد المستحق",
  Date: "التاريخ",
  Due: "تاريخ الاستحقاق",
  LPO: "أمر الشراء",
  Odometer: "عداد المسافات",
  TRN: "الرقم الضريبي",
  Notes: "ملاحظات",
  Reason: "السبب",
  Warranty: "الضمان",
  "Received by (customer)": "استلمه (العميل)",
  "Paid by (customer)": "دفعه (العميل)",
  "Customer approval": "موافقة العميل",
  "Service advisor": "مستشار الخدمة",
  Technician: "الفني",
  "Work / part": "العمل / القطعة",
  Type: "النوع",
  Done: "تم",
  "I authorise the work above": "أوافق على الأعمال المذكورة أعلاه",
  "Received from": "استلمنا من",
  "Paid to": "دفع إلى",
  "Allocated to": "مخصص لـ",
  Invoice: "الفاتورة",
  Number: "الرقم",
  Details: "البيان",
  Debit: "مدين",
  Credit: "دائن",
  Balance: "الرصيد",
  "Balance brought forward": "رصيد سابق",
  "Balance carried forward": "رصيد لاحق",
  "Total due": "إجمالي المستحق",
  "Less credit": "ناقص الرصيد الدائن",
  "Amount in words": "المبلغ كتابةً",
  Current: "جاري",
  "1–30 days": "1–30 يوماً",
  "31–60 days": "31–60 يوماً",
  "61–90 days": "61–90 يوماً",
  "Over 90 days": "أكثر من 90 يوماً",
};

/** A label in the document's language: "Total" or "Total / المجموع". Plain text; the caller escapes if needed. */
export function L(en: string, lang: DocLanguage): string {
  const ar = lang === "en_ar" ? AR[en] : undefined;
  return ar ? `${en} / ${ar}` : en;
}

/** "VAT 5%" or "VAT 5% / الضريبة 5%". */
export function vatLabel(pct: number, lang: DocLanguage): string {
  return lang === "en_ar" ? `VAT ${pct}% / الضريبة ${pct}%` : `VAT ${pct}%`;
}
