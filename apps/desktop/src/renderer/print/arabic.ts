import type { DocLanguage } from "@ffgp/shared";

let fontFaces = "";
/** Called once by `arabic-font.ts` (loaded at app start) with the embedded font's @font-face rules. */
export function registerArabicFont(css: string): void {
  fontFaces = css;
}

/**
 * Styles for English + Arabic pages: the embedded Noto Naskh Arabic font (see `arabic-font.ts`) and Arabic layout.
 * Only bilingual pages include it.
 */
export const arabicCss = () => `${fontFaces}
  body { font-family: "Segoe UI", -apple-system, Arial, "Noto Naskh Arabic", sans-serif; }
  [lang="ar"] { font-family: "Noto Naskh Arabic", "Segoe UI", Arial, sans-serif; }
  .ar-block { direction: rtl; text-align: right; margin-top: 1.5mm; }
  .ar-block .name { font-size: 14pt; font-weight: 700; color: #18181b; }
  .arl { direction: rtl; text-align: right; color: #3f3f46; font-size: 9.5pt; margin-top: 0.5mm; }
  .words { margin-top: 3mm; font-size: 9pt; color: #3f3f46; }
  .words[dir="rtl"] { margin-top: 1mm; font-size: 10pt; }
  table.items th { white-space: normal; vertical-align: bottom; line-height: 1.25; }
  table.items th [lang="ar"] { text-transform: none; letter-spacing: 0; font-size: 8.5pt; font-weight: 400; }
`;

/** Arabic for every printed label. Labels with no entry print in English only. */
const AR: Record<string, string> = {
  Employee: "الموظف",
  Job: "الوظيفة",
  "Days worked": "أيام العمل",
  Earnings: "المستحقات",
  Deductions: "الاستقطاعات",
  "Basic salary": "الراتب الأساسي",
  "Housing allowance": "بدل السكن",
  "Transport allowance": "بدل المواصلات",
  "Other allowance": "بدلات أخرى",
  "Unpaid leave": "إجازة بدون راتب",
  "Advance repayment": "سداد السلفة",
  "Net salary (WPS)": "صافي الراتب (نظام حماية الأجور)",
  "Cash bonus": "مكافأة نقدية",
  "Paid by": "طريقة الدفع",
  "Received by (employee)": "استلمه (الموظف)",
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
  TRN: "رقم التسجيل الضريبي",
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

/**
 * A label in the document's language: "Total" or "Total / المجموع". The Arabic is isolated (<bdi>) so a colon or
 * number after the label stays in English order. Constant labels only; nothing here comes from the user.
 */
export function L(en: string, lang: DocLanguage): string {
  const ar = lang === "en_ar" ? AR[en] : undefined;
  return ar ? `${en} / <bdi lang="ar">${ar}</bdi>` : en;
}

/** A table heading: English, with the Arabic on a second line on English + Arabic documents (keeps columns narrow). */
export function H(en: string, lang: DocLanguage): string {
  const ar = lang === "en_ar" ? AR[en] : undefined;
  return ar ? `${en}<br><span lang="ar">${ar}</span>` : en;
}

/** "VAT 5%" or "VAT 5% / الضريبة 5%". */
export function vatLabel(pct: number, lang: DocLanguage): string {
  return lang === "en_ar" ? `VAT ${pct}% / <bdi lang="ar">ضريبة القيمة المضافة ${pct}%</bdi>` : `VAT ${pct}%`;
}
