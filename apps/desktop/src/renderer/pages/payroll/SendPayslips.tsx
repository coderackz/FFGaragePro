import { Mail, MessageCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Modal, Spinner } from "../../components/ui";
import { get, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useApi } from "../../lib/useApi";
import { makePdf } from "../../messages/pdf";
import { openWhatsApp, uaePhone } from "../../messages/whatsapp";
import { renderPayslipsHtml, type Payslip } from "../../print/templates";
import type { Employee } from "./types";

interface Message { employeeId: string | null; channel: "email" | "whatsapp"; status: string }
const monthLong = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** Sends an approved payroll's payslips: by email (PDF attached, queued) to everyone with an address, or one by one on WhatsApp. */
export function SendPayslips({ open, runId, month, onClose }: { open: boolean; runId: string; month: string; onClose: () => void }) {
  const { garage, settings } = useAuth();
  const slips = useApi<{ payslips: Payslip[] }>(open ? `/api/payroll/runs/${runId}/payslips` : null);
  const people = useApi<{ employees: Employee[] }>(open ? "/api/employees?includeLeft=1" : null);
  const sent = useApi<{ messages: Message[] }>(open ? `/api/payroll/runs/${runId}/messages` : null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!open) return null;
  const ev = settings!.messages.payslip;
  const person = (id: string) => people.data?.employees.find((e) => e.id === id);
  const status = (id: string, channel: string) => sent.data?.messages.find((m) => m.employeeId === id && m.channel === channel)?.status;
  const text = (s: Payslip, ar: boolean) => {
    const fill = (t: string) => t.replace(/\{contact\}/g, s.employee.name).replace(/\{doc_number\}/g, monthLong(month)).replace(/\{garage\}/g, garage?.name ?? "");
    return { subject: fill(ar ? ev.subjectAr : ev.subjectEn), body: fill(ar ? ev.textAr : ev.textEn) };
  };
  const pdfOf = async (s: Payslip) => ({ fileName: `Payslip ${monthLong(month)} - ${s.employee.name}.pdf`, base64: await makePdf(renderPayslipsHtml([s], garage!, settings!)) });
  const emailAll = async () => {
    setBusy("email");
    let n = 0;
    try {
      for (const s of slips.data!.payslips) {
        const to = person(s.employee.id)?.email;
        if (!to || status(s.employee.id, "email")) continue;
        const t = text(s, false);
        await post("/api/messages", {
          event: "payslip", channel: "email", employeeId: s.employee.id, recipient: to, subject: t.subject, body: t.body,
          attachment: await pdfOf(s), dedupeKey: `payslip:${runId}:${s.employee.id}`,
        });
        n++;
      }
      toast.success(n ? `${n} payslip${n === 1 ? "" : "s"} queued by email` : "Nothing new to email");
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); await sent.reload(); }
  };
  const whatsApp = async (s: Payslip, phone: string) => {
    setBusy(s.employee.id);
    try {
      const t = text(s, false);
      await openWhatsApp(phone, t.body, await pdfOf(s));
      await post("/api/messages", { event: "payslip", channel: "whatsapp", employeeId: s.employee.id, recipient: phone, body: t.body, dedupeKey: `payslip:${runId}:${s.employee.id}:whatsapp` });
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); await sent.reload(); }
  };
  return (
    <Modal open title={`Send payslips: ${monthLong(month)}`} onClose={onClose} width="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" icon={<Mail className="size-4" />} busy={busy === "email"} disabled={!slips.data} onClick={() => void emailAll()}>Email all with an address</Button></>}>
      {!slips.data || !people.data ? <Spinner /> : (
        <table className="w-full text-sm"><tbody>
          {slips.data.payslips.map((s) => {
            const p = person(s.employee.id);
            const phone = p?.phone ? uaePhone(p.phone) : null;
            const email = status(s.employee.id, "email");
            const wa = status(s.employee.id, "whatsapp");
            return (
              <tr key={s.employee.id} className="border-b border-zinc-100">
                <td className="py-2 font-medium">{s.employee.name}</td>
                <td className="py-2 text-zinc-600">{p?.email ?? <span className="text-zinc-400">no email</span>}{email && <span className="ml-2"><Badge>{email === "sent" ? "Sent" : email === "failed" ? "Failed" : "Queued"}</Badge></span>}</td>
                <td className="py-2 text-right">
                  {phone ? <Button size="sm" variant="ghost" icon={<MessageCircle className="size-3.5" />} busy={busy === s.employee.id} onClick={() => void whatsApp(s, phone)}>{wa ? "WhatsApp again" : "WhatsApp"}</Button>
                    : <span className="text-xs text-zinc-400">no mobile</span>}
                </td>
              </tr>
            );
          })}
        </tbody></table>
      )}
    </Modal>
  );
}
