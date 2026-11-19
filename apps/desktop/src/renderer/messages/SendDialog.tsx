import type { Recipient } from "@ffgp/shared";
import { Mail, MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { Customer } from "../lib/types";
import { EVENT_LABELS } from "./labels";
import { makePdf } from "./pdf";
import { compose, loadRecipients, logWhatsApp, onAskToSend, queueEmail, type SendRequest } from "./triggers";
import { openWhatsApp, uaePhone } from "./whatsapp";

/** Mounted once in the layout: opens the Send dialog whenever something asks to send a message. */
export function SendDialogHost() {
  const [request, setRequest] = useState<SendRequest | null>(null);
  useEffect(() => onAskToSend(setRequest), []);
  return request ? <SendDialog request={request} onClose={() => setRequest(null)} /> : null;
}

const optionKey = (r: Recipient, i: number) => `${i}: ${r.name}`;

/** Pick who gets it, check the text (in their language), then email it or open it in WhatsApp. */
export function SendDialog({ request: r, onClose }: { request: SendRequest; onClose: () => void }) {
  const { settings } = useAuth();
  const ev = settings!.messages[r.event];
  const channel = r.manual ? "both" : ev.channel;
  const [data, setData] = useState<{ customer: Customer; recipients: Recipient[] } | null>(null);
  const [index, setIndex] = useState(0);
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"email" | "whatsapp" | null>(null);
  const [done, setDone] = useState<{ email?: boolean; whatsapp?: boolean }>({});
  const pdf = useRef<Promise<{ fileName: string; base64: string }> | null>(null);

  useEffect(() => {
    void loadRecipients(r).then((d) => {
      setData(d);
      if (d.recipients[0]) setLanguage(d.recipients[0].language);
    }, (err: Error) => toast.error(err.message));
  }, [r]);

  const to = data?.recipients[index];
  useEffect(() => {
    if (!data || !to) return;
    const text = compose(r, ev, to, language, data.customer.balanceFils ?? null);
    setSubject(text.subject);
    setBody(text.body);
  }, [data, to, language, r, ev]);

  const attachment = () => {
    if (!r.pdf) return Promise.resolve(null);
    const { fileName, html } = r.pdf;
    pdf.current ??= makePdf(html()).then((base64) => ({ fileName, base64 }));
    return pdf.current;
  };
  const phone = to?.phone ? uaePhone(to.phone) : null;
  const canEmail = !!to?.email && channel !== "whatsapp" && !r.whatsappOnly;
  const canWhatsApp = !!phone && channel !== "email";
  // Make the PDF straight away: a browser only lets WhatsApp open in a new tab right after the click.
  useEffect(() => {
    if (canWhatsApp && r.pdf) void attachment();
  }, [canWhatsApp, r]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendEmail = async () => {
    if (!to?.email) return;
    setBusy("email");
    try {
      await queueEmail(r, { ...to, email: to.email }, { subject, body }, await attachment(), false);
      toast.success(`Email to ${to.name} is on its way`);
      setDone((d) => ({ ...d, email: true }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const sendWhatsApp = async () => {
    if (!to || !phone) return;
    setBusy("whatsapp");
    try {
      await openWhatsApp(phone, body, await attachment());
      await logWhatsApp(r, to, phone, body);
      setDone((d) => ({ ...d, whatsapp: true }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Send: ${EVENT_LABELS[r.event]}`} width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>{done.email || done.whatsapp ? "Done" : "Not now"}</Button>
          {canWhatsApp && (
            <Button variant={canEmail ? "secondary" : "primary"} icon={<MessageCircle className="size-4" />} busy={busy === "whatsapp"} disabled={!body.trim()} onClick={() => void sendWhatsApp()}>
              {done.whatsapp ? "Open WhatsApp again" : "Open WhatsApp"}
            </Button>
          )}
          {canEmail && (
            <Button variant="primary" icon={<Mail className="size-4" />} busy={busy === "email"} disabled={done.email || !body.trim() || !subject.trim()} onClick={() => void sendEmail()}>
              {done.email ? "Emailed" : "Send email"}
            </Button>
          )}
        </>
      }>
      {!data ? <Spinner /> : !to ? (
        <p className="text-sm text-zinc-700">
          {data.customer.name} has no phone or email for this message. Add a contact on their page (Contacts), then send it from there.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label="Send to">
              <Select value={optionKey(to, index)} onChange={(e) => setIndex(Number.parseInt(e.target.value, 10))} aria-label="Send to">
                {data.recipients.map((x, i) => (
                  <option key={optionKey(x, i)} value={optionKey(x, i)}>{[x.name, x.phone, x.email].filter(Boolean).join(" · ")}</option>
                ))}
              </Select>
            </Field>
            <Field label="Language">
              <Select value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ar")} aria-label="Language">
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </Select>
            </Field>
          </div>
          {canEmail && <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" dir={language === "ar" ? "rtl" : undefined} /></Field>}
          <Field label="Message">
            <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" dir={language === "ar" ? "rtl" : undefined} lang={language} />
          </Field>
          {r.pdf && <p className="text-xs text-zinc-500">Attached: {r.pdf.fileName}{canWhatsApp ? ". For WhatsApp it's saved for you to drag into the chat." : ""}</p>}
          {!canEmail && !canWhatsApp && (
            <p className="text-sm text-amber-700">
              {to.phone && !phone ? `${to.phone} isn't a mobile number WhatsApp can use. ` : ""}
              {channel === "email" ? "This message goes by email, and there's no email address for them." : "There's no WhatsApp mobile or email address for them."}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
