import { Mail, MessageCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DEFAULT_SETTINGS } from "@ffgp/shared";
import { useAuth } from "../lib/auth";
import type { PurchaseOrder } from "../lib/types";
import { orderText, sendToVendor, whatsappOf } from "../messages/vendors";
import { Button, Modal } from "./ui";

/** Sends an order to its vendor by WhatsApp or email, with the purchase order PDF; a draft becomes sent. */
export function SendToVendorDialog({ po, open, onClose, onSent }: { po: PurchaseOrder; open: boolean; onClose: () => void; onSent: (po: PurchaseOrder) => void }) {
  const { garage, settings } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const s = po.supplier;
  if (!s || !garage) return null;
  const to = { supplierId: s.id, name: s.name, phone: s.phone, email: s.email };
  const send = async (channel: "whatsapp" | "email") => {
    setBusy(channel);
    try {
      onSent(await sendToVendor(po, to, channel, garage, settings ?? DEFAULT_SETTINGS));
      toast.success(channel === "email" ? `Emailed to ${s.name}` : `WhatsApp opened for ${s.name}`);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Send ${po.number} to ${s.name}`}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button icon={<Mail className="size-4" />} disabled={!s.email} busy={busy === "email"} onClick={() => void send("email")}>Email{s.email ? ` ${s.email}` : ""}</Button>
        <Button variant="primary" icon={<MessageCircle className="size-4" />} disabled={!whatsappOf(to)} busy={busy === "whatsapp"} onClick={() => void send("whatsapp")}>WhatsApp</Button>
      </>}>
      <pre className="rounded-md bg-zinc-50 p-3 font-sans text-sm whitespace-pre-wrap text-zinc-700">{orderText(po, garage).body}</pre>
      <p className="mt-2 text-xs text-zinc-500">The purchase order PDF goes with it.{!s.phone && !s.email ? " Save a mobile number or email on the supplier to send it from here." : ""}</p>
    </Modal>
  );
}
