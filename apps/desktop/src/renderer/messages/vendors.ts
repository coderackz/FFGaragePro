import { formatAED } from "../lib/format";
import { post } from "../lib/api";
import type { Settings } from "@ffgp/shared";
import type { Garage, Message, PurchaseOrder } from "../lib/types";
import { renderPriceRequestHtml, renderPurchaseOrderHtml, vendorVehicle } from "../print/templates";
import { messagesChanged } from "./triggers";
import { makePdf } from "./pdf";
import { openWhatsApp, uaePhone } from "./whatsapp";

/** Who a vendor message can go to, and how. */
export interface VendorTo { supplierId: string; name: string; phone: string | null; email: string | null }
export const whatsappOf = (v: VendorTo) => (v.phone ? uaePhone(v.phone) : null);

const vehicleLines = (po: PurchaseOrder) => {
  const v = po.job?.vehicle;
  return v ? [vendorVehicle(v), v.vin ? `VIN ${v.vin}` : null].filter(Boolean) as string[] : [];
};

/** The text asking a vendor for prices: the parts, the vehicle and VIN, the reference. */
export function priceRequestText(po: PurchaseOrder, garage: Garage): { subject: string; body: string } {
  return {
    subject: `Request for prices ${po.number} — ${garage.name}`,
    body: [
      `${garage.name}: request for prices, ref ${po.number}`,
      ...vehicleLines(po),
      ...po.lines.map((l) => `${l.qty} × ${l.description}`),
      "Please send your price and availability for each part.",
    ].join("\n"),
  };
}

/** The text sending an order: the parts at the prices agreed, and the total before VAT. */
export function orderText(po: PurchaseOrder, garage: Garage): { subject: string; body: string } {
  const priced = po.netFils !== undefined;
  return {
    subject: `Purchase order ${po.number} — ${garage.name}`,
    body: [
      `${garage.name}: purchase order ${po.number}`,
      ...vehicleLines(po),
      ...po.lines.map((l) => `${l.qty} × ${l.description}${priced && l.unitCostFils ? ` @ ${formatAED(l.unitCostFils)}` : ""}`),
      ...(priced ? [`Total ${formatAED(po.netFils ?? 0)} before VAT`] : []),
      `Please confirm and deliver, quoting ${po.number}.`,
    ].join("\n"),
  };
}

/**
 * Sends a vendor the request for prices (when `po` is a request) or the order: WhatsApp opens the chat with the text
 * (the PDF saved to drag in) and is logged; email goes from the garage's mailbox with the PDF. Returns the order as
 * it now stands.
 */
export async function sendToVendor(
  po: PurchaseOrder, to: VendorTo, channel: "whatsapp" | "email", garage: Garage, settings: Settings, photos: { label: string; base64: string }[] = [],
): Promise<PurchaseOrder> {
  const text = po.request ? priceRequestText(po, garage) : orderText(po, garage);
  const html = po.request ? renderPriceRequestHtml(po, garage, settings, photos) : renderPurchaseOrderHtml(po, garage, settings);
  const pdf = { fileName: `${po.number}.pdf`, base64: await makePdf(html) };
  let recipient: string;
  if (channel === "whatsapp") {
    const phone = whatsappOf(to);
    if (!phone) throw new Error(`${to.name} has no mobile number for WhatsApp`);
    await openWhatsApp(phone, text.body, pdf);
    recipient = phone;
  } else {
    if (!to.email) throw new Error(`${to.name} has no email address`);
    recipient = to.email;
  }
  const res = await post<{ message: Message; purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${po.id}/messages`, {
    supplierId: to.supplierId, channel, recipient, subject: channel === "email" ? text.subject : null, body: text.body,
    attachment: channel === "email" ? pdf : null,
  });
  messagesChanged();
  return res.purchaseOrder;
}
