import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ffgp", {
  apiBase: ipcRenderer.sendSync("ffgp:apiBase") as string,
  savePdf: (html: string, fileName: string) => ipcRenderer.invoke("ffgp:savePdf", { html, fileName }) as Promise<string | null>,
  print: (html: string) => ipcRenderer.invoke("ffgp:print", { html }) as Promise<boolean>,
});
