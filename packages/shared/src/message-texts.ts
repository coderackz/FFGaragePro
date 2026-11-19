import type { MessageEvent } from "./messages";

export interface EventTexts { subjectEn: string; subjectAr: string; textEn: string; textAr: string }

/** The default subject and text of each message, in English and Arabic. Garages edit them in Settings → Messages. */
export const DEFAULT_MESSAGE_TEXTS: Record<MessageEvent, EventTexts> = {
  vehicle_received: {
    subjectEn: "{plate} received at {garage}",
    textEn: "Dear {contact}, we have received your vehicle {plate} ({vehicle}). Job card {doc_number}. We will keep you updated. {garage}, {garage_phone}",
    subjectAr: "استلام المركبة {plate} - {garage}",
    textAr: "عزيزي {contact}، تم استلام مركبتكم {plate} ({vehicle}). رقم بطاقة العمل {doc_number}. سنبقيكم على اطلاع. {garage}، {garage_phone}",
  },
  estimate_ready: {
    subjectEn: "Estimate {doc_number} for {plate}",
    textEn: "Dear {contact}, please find attached estimate {doc_number} for {plate}, total {amount}. Please reply to approve. {garage}, {garage_phone}",
    subjectAr: "عرض السعر {doc_number} للمركبة {plate}",
    textAr: "عزيزي {contact}، مرفق عرض السعر {doc_number} للمركبة {plate} بإجمالي {amount}. يرجى الرد بالموافقة. {garage}، {garage_phone}",
  },
  estimate_resent: {
    subjectEn: "Extra work needs approval: {doc_number}",
    textEn:
      "Dear {contact}, while working on {plate} we found extra work. The updated estimate {doc_number} is attached, total {amount}. Please reply to approve. {garage}, {garage_phone}",
    subjectAr: "أعمال إضافية بحاجة إلى موافقة: {doc_number}",
    textAr:
      "عزيزي {contact}، أثناء العمل على المركبة {plate} وجدنا أعمالاً إضافية. مرفق عرض السعر المحدّث {doc_number} بإجمالي {amount}. يرجى الرد بالموافقة. {garage}، {garage_phone}",
  },
  vehicle_ready: {
    subjectEn: "{plate} is ready",
    textEn: "Dear {contact}, your vehicle {plate} is ready for collection. {garage}, {garage_phone}",
    subjectAr: "المركبة {plate} جاهزة",
    textAr: "عزيزي {contact}، مركبتكم {plate} جاهزة للاستلام. {garage}، {garage_phone}",
  },
  invoice_issued: {
    subjectEn: "Invoice {doc_number} from {garage}",
    textEn: "Dear {contact}, please find attached invoice {doc_number} for {plate}, total {amount}, due {due_date}. Thank you. {garage}, {garage_phone}",
    subjectAr: "الفاتورة {doc_number} من {garage}",
    textAr: "عزيزي {contact}، مرفق الفاتورة {doc_number} للمركبة {plate} بإجمالي {amount}، تاريخ الاستحقاق {due_date}. شكراً لكم. {garage}، {garage_phone}",
  },
  payment_received: {
    subjectEn: "Receipt {doc_number} from {garage}",
    textEn: "Dear {contact}, thank you for your payment of {amount}. Receipt {doc_number} is attached. Your balance is now {balance}. {garage}",
    subjectAr: "سند القبض {doc_number} من {garage}",
    textAr: "عزيزي {contact}، شكراً لدفعتكم بمبلغ {amount}. مرفق سند القبض {doc_number}. رصيدكم الحالي {balance}. {garage}",
  },
  payment_due: {
    subjectEn: "Invoice {doc_number} is due on {due_date}",
    textEn:
      "Dear {contact}, a reminder that invoice {doc_number} for {amount} is due on {due_date}. If you have already paid, thank you. {garage}, {garage_phone}",
    subjectAr: "تذكير: الفاتورة {doc_number} مستحقة في {due_date}",
    textAr:
      "عزيزي {contact}، نود تذكيركم بأن الفاتورة {doc_number} بمبلغ {amount} مستحقة بتاريخ {due_date}. إذا كنتم قد سددتم المبلغ فشكراً لكم. {garage}، {garage_phone}",
  },
  payment_overdue: {
    subjectEn: "Invoice {doc_number} is overdue",
    textEn: "Dear {contact}, invoice {doc_number} for {amount} was due on {due_date} and is still unpaid. Please arrange payment. {garage}, {garage_phone}",
    subjectAr: "الفاتورة {doc_number} متأخرة السداد",
    textAr: "عزيزي {contact}، الفاتورة {doc_number} بمبلغ {amount} كانت مستحقة بتاريخ {due_date} ولم تُسدَّد بعد. يرجى ترتيب السداد. {garage}، {garage_phone}",
  },
  statement: {
    subjectEn: "Statement of account from {garage}",
    textEn: "Dear {contact}, please find attached your statement of account. Balance due: {balance}. {garage}, {garage_phone}",
    subjectAr: "كشف الحساب من {garage}",
    textAr: "عزيزي {contact}، مرفق كشف حسابكم. الرصيد المستحق: {balance}. {garage}، {garage_phone}",
  },
};
