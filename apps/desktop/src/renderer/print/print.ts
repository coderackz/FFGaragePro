import type { Settings } from "@ffgp/shared";
import { toast } from "sonner";
import { post } from "../lib/api";
import type { DocumentFull, Garage, PurchaseOrder } from "../lib/types";
import { renderDocumentHtml, renderPurchaseOrderHtml } from "./templates";

/** Prints or saves a document. An issued invoice's prints are counted: the second and later ones say COPY. */
export async function printDocument(doc: DocumentFull, garage: Garage, settings: Settings, mode: "pdf" | "print"): Promise<void> {
  const counted = doc.type === "invoice" && doc.status !== "draft";
  const copy = counted ? (await post<{ count: number }>(`/api/documents/${doc.id}/prints`)).count > 1 : false;
  return printHtml(renderDocumentHtml(doc, garage, settings, { copy }), `${doc.number} - ${doc.customer.name}`, mode);
}

export function printPurchaseOrder(po: PurchaseOrder, garage: Garage, settings: Settings, mode: "pdf" | "print"): Promise<void> {
  return printHtml(renderPurchaseOrderHtml(po, garage, settings), `${po.number} - ${po.supplier.name}`, mode);
}

export async function printHtml(html: string, title: string, mode: "pdf" | "print"): Promise<void> {
  const bridge = window.ffgp;
  if (bridge) {
    if (mode === "pdf") {
      const safeName = title.replace(/[\\/:*?"<>|]+/g, " ").trim();
      const path = await bridge.savePdf(html, `${safeName}.pdf`);
      if (path) toast.success("PDF saved", { description: path });
    } else {
      await bridge.print(html);
    }
    return;
  }
  // Browser fallback (development): print from a hidden frame.
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise((r) => (frame.onload = r));
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}
