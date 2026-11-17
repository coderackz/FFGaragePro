import { toast } from "sonner";
import type { DocumentFull, Garage } from "../lib/types";
import { renderDocumentHtml } from "./templates";

export async function printDocument(doc: DocumentFull, garage: Garage, mode: "pdf" | "print"): Promise<void> {
  const html = renderDocumentHtml(doc, garage);
  const bridge = window.ffgp;
  if (bridge) {
    if (mode === "pdf") {
      const safeName = doc.customer.name.replace(/[\\/:*?"<>|]+/g, " ").trim();
      const path = await bridge.savePdf(html, `${doc.number} - ${safeName}.pdf`);
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
