const TOKEN_KEY = "ffgp.token";
const GARAGE_KEY = "ffgp.garage";

/** Built for Fleetfix Cloud (the browser app): every call names its garage. */
export const isCloud = import.meta.env.VITE_FFGP_CLOUD === "1";

export function getGarageCode(): string | null {
  try {
    return localStorage.getItem(GARAGE_KEY);
  } catch {
    return memoryGarage;
  }
}
export function setGarageCode(code: string | null): void {
  memoryGarage = code;
  try {
    if (code) localStorage.setItem(GARAGE_KEY, code);
    else localStorage.removeItem(GARAGE_KEY);
  } catch {
    /* storage unavailable: remembered until reload */
  }
}
let memoryGarage: string | null = null;

export const apiBase: string = window.ffgp?.apiBase ?? import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4780";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts until reload */
  }
  memoryToken = token;
}

let memoryToken: string | null = getToken();

export async function api<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (isCloud) {
    const garage = getGarageCode();
    if (garage) headers["x-ffgp-garage"] = garage;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  if (memoryToken) headers.authorization = `Bearer ${memoryToken}`;
  if (window.ffgp?.deviceKey) headers["x-ffgp-device"] = window.ffgp.deviceKey;
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, isCloud ? "Can't reach Fleetfix Cloud. Check the internet connection" : window.ffgp?.mode === "client" ? "Can't reach the main computer" : "Can't reach the garage server");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    if (data.code === "unknown_garage") {
      window.dispatchEvent(new Event("ffgp:unknown-garage"));
      throw new ApiError(res.status, data.error ?? "No garage with that ID", data.code);
    }
    if (data.code === "device_not_paired") {
      window.dispatchEvent(new Event("ffgp:unpaired"));
      throw new ApiError(res.status, data.error ?? "This PC isn't connected", data.code);
    }
    if (res.status === 401 && memoryToken && !path.startsWith("/api/auth/login")) {
      setToken(null);
      window.dispatchEvent(new Event("ffgp:signed-out"));
    }
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>("POST", path, body ?? {}, headers);
export const patch = <T,>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const put = <T,>(path: string, body: unknown) => api<T>("PUT", path, body);
export const del = <T,>(path: string) => api<T>("DELETE", path);
