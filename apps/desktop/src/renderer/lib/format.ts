export { formatAED } from "@ffgp/shared";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const formatDate = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : "—");
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : "—");
export const formatKm = (km: number | null | undefined) => (km == null ? "—" : `${km.toLocaleString("en-US")} km`);
export const vehicleLabel = (v: { make: string | null; model: string | null; year: number | null }) =>
  [v.make, v.model, v.year].filter(Boolean).join(" ") || "—";

export const PAYMENT_LABELS: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque" };
