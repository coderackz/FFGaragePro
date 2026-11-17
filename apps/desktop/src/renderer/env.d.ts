/// <reference types="vite/client" />

interface FfgpBridge {
  apiBase: string;
  savePdf(html: string, fileName: string): Promise<string | null>;
  print(html: string): Promise<boolean>;
}

interface Window {
  ffgp?: FfgpBridge;
}

declare module "*.png" {
  const src: string;
  export default src;
}
