import type { MessageEvent } from "@ffgp/shared";

/** What each message is called on screen. */
export const EVENT_LABELS: Record<MessageEvent, string> = {
  vehicle_received: "Vehicle received",
  estimate_ready: "Estimate ready",
  estimate_resent: "Extra work needs approval",
  vehicle_ready: "Vehicle ready",
  invoice_issued: "Invoice issued",
  payment_received: "Payment received",
  payment_due: "Payment due soon",
  payment_overdue: "Payment overdue",
  statement: "Monthly statement",
  payslip: "Payslip",
};
