import type { MessageEvent } from "./messages";

export interface EventTexts { subjectEn: string; textEn: string }

/** The default subject and text of each message. Garages edit them in Settings → Messages. */
export const DEFAULT_MESSAGE_TEXTS: Record<MessageEvent, EventTexts> = {
  vehicle_received: {
    subjectEn: "{plate} received at {garage}",
    textEn: "Dear {contact}, we have received your vehicle {plate} ({vehicle}). Job card {doc_number}. We will keep you updated. {garage}, {garage_phone}",
  },
  estimate_ready: {
    subjectEn: "Estimate {doc_number} for {plate}",
    textEn: "Dear {contact}, please find attached estimate {doc_number} for {plate}, total {amount}. Please reply to approve. {garage}, {garage_phone}",
  },
  estimate_resent: {
    subjectEn: "Extra work needs approval: {doc_number}",
    textEn:
      "Dear {contact}, while working on {plate} we found extra work. The updated estimate {doc_number} is attached, total {amount}. Please reply to approve. {garage}, {garage_phone}",
  },
  vehicle_ready: {
    subjectEn: "{plate} is ready",
    textEn: "Dear {contact}, your vehicle {plate} is ready for collection. {garage}, {garage_phone}",
  },
  invoice_issued: {
    subjectEn: "Invoice {doc_number} from {garage}",
    textEn: "Dear {contact}, please find attached invoice {doc_number} for {plate}, total {amount}, due {due_date}. Thank you. {garage}, {garage_phone}",
  },
  payment_received: {
    subjectEn: "Receipt {doc_number} from {garage}",
    textEn: "Dear {contact}, thank you for your payment of {amount}. Receipt {doc_number} is attached. Your balance is now {balance}. {garage}",
  },
  payment_due: {
    subjectEn: "Invoice {doc_number} is due on {due_date}",
    textEn:
      "Dear {contact}, a reminder that invoice {doc_number} for {amount} is due on {due_date}. If you have already paid, thank you. {garage}, {garage_phone}",
  },
  payment_overdue: {
    subjectEn: "Invoice {doc_number} is overdue",
    textEn: "Dear {contact}, invoice {doc_number} for {amount} was due on {due_date} and is still unpaid. Please arrange payment. {garage}, {garage_phone}",
  },
  payslip: {
    subjectEn: "Your payslip for {doc_number}",
    textEn: "Dear {contact}, please find attached your payslip for {doc_number}. {garage}",
  },
  statement: {
    subjectEn: "Statement of account from {garage}",
    textEn: "Dear {contact}, please find attached your statement of account. Balance due: {balance}. {garage}, {garage_phone}",
  },
};
