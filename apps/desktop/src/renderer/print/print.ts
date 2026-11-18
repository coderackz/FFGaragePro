import { toast } from "sonner";
import type { DocumentFull, Garage, PurchaseOrder } from "../lib/types";
import { renderDocumentHtml, renderPurchaseOrderHtml } from "./templates";

export function printDocument(doc: DocumentFull, garage: Garage, mode: "pdf" | "print"): Promise<void> {
  return printHtml(renderDocumentHtml(doc, garage), `${doc.number} - ${doc.customer.name}`, mode);
}

export function printPurchaseOrder(po: PurchaseOrder, garage: Garage, mode: "pdf" | "print"): Promise<void> {
  return printHtml(renderPurchaseOrderHtml(po, garage), `${po.number} - ${po.supplier.name}`, mode);
}

async function printHtml(html: string, title: string, mode: "pdf" | "print"): Promise<void> {
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
