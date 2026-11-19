import regular from "@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-400-normal.woff2?inline";
import bold from "@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-700-normal.woff2?inline";
import { registerArabicFont } from "./arabic";

/*
 * Noto Naskh Arabic (SIL Open Font License 1.1), embedded as data URLs so printing, PDFs and the Settings preview draw
 * Arabic the same way on every PC and browser, offline. Kept in its own module (imported by main.tsx) because only a
 * Vite build can read `?inline` font files.
 */
registerArabicFont(`
  @font-face { font-family: "Noto Naskh Arabic"; font-weight: 400; font-style: normal; src: url(${regular}) format("woff2"); }
  @font-face { font-family: "Noto Naskh Arabic"; font-weight: 700; font-style: normal; src: url(${bold}) format("woff2"); }
`);
