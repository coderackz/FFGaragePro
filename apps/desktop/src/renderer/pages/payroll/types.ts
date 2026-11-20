export interface Employee {
  id: string; name: string; nameAr: string | null; job: string; nationality: string | null; joinDate: string; leftDate: string | null;
  basicFils: number; housingFils: number; transportFils: number; otherAllowanceFils: number; payMethod: "bank" | "salary_card";
  iban: string | null; cardNumber: string | null; routingCode: string | null; personId: string | null;
  emiratesId: string | null; emiratesIdExpiry: string | null; labourCard: string | null; labourCardExpiry: string | null;
  passport: string | null; passportExpiry: string | null; visa: string | null; visaExpiry: string | null;
  language: "en" | "en_ar"; phone: string | null; email: string | null;
  /** Annual leave days owed on a date from before the app. */
  leaveBalanceDays: number | null; leaveBalanceDate: string | null;
}
export interface EmployeeFull extends Employee {
  leave: { id: string; kind: "annual" | "sick" | "unpaid"; from: string; to: string; note: string | null }[];
  advances: { id: string; amountFils: number; paidOn: string; instalmentFils: number; note: string | null; owedFils: number; repaidFils: number; cancelled: boolean }[];
  advanceOwedFils: number; annualLeaveDays: number;
  expiring: Expiring[];
}
export interface Expiring { employeeId: string; name: string; document: string; expires: string }
export const grossOf = (e: Employee) => e.basicFils + e.housingFils + e.transportFils + e.otherAllowanceFils;
