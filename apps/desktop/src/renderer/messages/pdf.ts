/** A4 at 96 dpi: the page the print templates are laid out for. */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

/**
 * A printable page as a PDF (base64), to attach to an email or hand to WhatsApp. On a PC, Electron prints it like
 * "Save as PDF" (real text). In the browser app the page is drawn as an image and cut into A4 pages: text isn't
 * selectable and a line can be cut at a page edge (Part 3b decision).
 */
export async function makePdf(html: string): Promise<string> {
  if (window.ffgp?.makePdf) return window.ffgp.makePdf(html);
  return browserPdf(html);
}

async function browserPdf(html: string): Promise<string> {
  const [{ toPng }, { PDFDocument }] = await Promise.all([import("html-to-image"), import("pdf-lib")]);
  const frame = document.createElement("iframe");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${A4_WIDTH_PX}px;height:${A4_HEIGHT_PX}px;border:0;`;
  frame.srcdoc = html;
  document.body.appendChild(frame);
  try {
    await new Promise((r) => (frame.onload = r));
    const doc = frame.contentDocument!;
    await doc.fonts?.ready;
    const body = doc.body;
    const height = Math.max(body.scrollHeight, A4_HEIGHT_PX);
    const pdf = await PDFDocument.create();
    // A4 in PDF points. Each page is drawn on its own (one tall canvas would be scaled down, or fail, on long
    // statements): the page body is shifted up by the pages before it.
    const pageW = 595.28;
    const pageH = 841.89;
    const pages = Math.max(1, Math.ceil(height / A4_HEIGHT_PX));
    for (let i = 0; i < pages; i++) {
      // PNG: printed pages are mostly white with black text, which PNG keeps sharp and small (JPEG doesn't).
      const png = await toPng(body, {
        width: A4_WIDTH_PX, height: A4_HEIGHT_PX, pixelRatio: 1.4, backgroundColor: "#ffffff",
        style: { transform: `translateY(-${i * A4_HEIGHT_PX}px)`, transformOrigin: "top left" },
      });
      // pdf-lib reads the data URL itself (the page's security policy doesn't allow fetching data: URLs).
      const img = await pdf.embedPng(png);
      pdf.addPage([pageW, pageH]).drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
    }
    return await pdf.saveAsBase64();
  } finally {
    frame.remove();
  }
}
