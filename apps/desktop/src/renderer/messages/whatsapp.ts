/**
 * A phone number as WhatsApp wants it: digits with the country code, no + or 00. UAE mobiles may be typed any common
 * way (050 123 4567, +971 50…, 00971…, 50…); other countries need + or 00. Landlines and rubbish give null.
 */
export function uaePhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  let digits: string;
  let international = false;
  if (compact.startsWith("+")) {
    digits = compact.slice(1);
    international = true;
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
    international = true;
  } else {
    digits = compact;
  }
  if (digits.startsWith("971")) return /^9715\d{8}$/.test(digits) ? digits : null;
  if (international) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (/^05\d{8}$/.test(digits)) return `971${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `971${digits}`;
  return null;
}

/** Opens a chat with `phone` (digits from uaePhone) with `text` typed in. */
export const whatsappUrl = (phone: string, text: string) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;

/**
 * Hands a message to WhatsApp: on a PC the PDF is saved to Documents/Fleetfix Garage Pro/Sent and shown in its folder,
 * ready to drag into the chat; in the browser it downloads. Staff press Send in WhatsApp.
 */
export async function openWhatsApp(phone: string, text: string, pdf?: { fileName: string; base64: string } | null): Promise<void> {
  const url = whatsappUrl(phone, text);
  if (window.ffgp?.whatsapp) {
    await window.ffgp.whatsapp({ url, pdf: pdf ?? null });
    return;
  }
  if (pdf) {
    const bytes = Uint8Array.from(atob(pdf.base64), (c) => c.charCodeAt(0));
    const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = pdf.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }
  window.open(url, "_blank", "noopener");
}
