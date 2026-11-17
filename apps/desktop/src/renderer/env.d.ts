/// <reference types="vite/client" />

interface FfgpBridge {
  apiBase: string;
  /** Set on a PC connected to a main computer; sent with every request. */
  deviceKey: string | null;
  /** local: single PC · main: sharing with other PCs · client: connected to a main computer */
  mode: "local" | "main" | "client";
  mainComputer: { host: string; garageName: string } | null;
  hostname: string;
  savePdf(html: string, fileName: string): Promise<string | null>;
  print(html: string): Promise<boolean>;
  discover(): Promise<{ host: string; port: number; name: string }[]>;
  connect(args: { host: string; code: string; deviceName: string }): Promise<{ ok?: true; error?: string }>;
  disconnect(): Promise<void>;
  applyNetwork(): Promise<void>;
}

interface Window {
  ffgp?: FfgpBridge;
}

declare module "*.png" {
  const src: string;
  export default src;
}
