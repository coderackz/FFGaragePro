import { contextBridge, ipcRenderer } from "electron";

const info = ipcRenderer.sendSync("ffgp:info") as {
  apiBase: string;
  deviceKey: string | null;
  mode: "local" | "main" | "client";
  mainComputer: { host: string; garageName: string } | null;
  hostname: string;
  cloudLinked: boolean;
};

contextBridge.exposeInMainWorld("ffgp", {
  ...info,
  savePdf: (html: string, fileName: string) => ipcRenderer.invoke("ffgp:savePdf", { html, fileName }) as Promise<string | null>,
  print: (html: string) => ipcRenderer.invoke("ffgp:print", { html }) as Promise<boolean>,
  discover: () => ipcRenderer.invoke("ffgp:discover"),
  connect: (args: { host: string; code: string; deviceName: string }) => ipcRenderer.invoke("ffgp:connect", args),
  disconnect: () => ipcRenderer.invoke("ffgp:disconnect"),
  applyNetwork: () => ipcRenderer.invoke("ffgp:applyNetwork"),
  cloudStatus: () => ipcRenderer.invoke("ffgp:cloudStatus"),
  cloudLink: (args: unknown) => ipcRenderer.invoke("ffgp:cloudLink", args),
  cloudSyncNow: () => ipcRenderer.invoke("ffgp:cloudSyncNow"),
  cloudUnlink: () => ipcRenderer.invoke("ffgp:cloudUnlink"),
  onCloudStatus: (cb: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => cb(status);
    ipcRenderer.on("ffgp:cloud-status", listener);
    return () => void ipcRenderer.removeListener("ffgp:cloud-status", listener);
  },
});
