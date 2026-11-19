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
  const [{ toJpeg }, { PDFDocument }] = await Promise.all([import("html-to-image"), import("pdf-lib")]);
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
    const jpeg = await toJpeg(body, { width: A4_WIDTH_PX, height, pixelRatio: 2, backgroundColor: "#ffffff", quality: 0.92 });
    const pdf = await PDFDocument.create();
    // pdf-lib reads the data URL itself (the page's security policy doesn't allow fetching data: URLs).
    const img = await pdf.embedJpg(jpeg);
    // A4 in PDF points; the image is cut into page-tall slices by drawing it shifted up on each page.
    const pageW = 595.28;
    const pageH = 841.89;
    const scale = pageW / A4_WIDTH_PX;
    const pages = Math.max(1, Math.ceil(height / A4_HEIGHT_PX));
    for (let i = 0; i < pages; i++) {
      const page = pdf.addPage([pageW, pageH]);
      const drawnH = height * scale;
      page.drawImage(img, { x: 0, y: pageH - drawnH + i * pageH, width: pageW, height: drawnH });
    }
    return await pdf.saveAsBase64();
  } finally {
    frame.remove();
  }
}
