const TOKEN_KEY = "ffgp.token";

export const apiBase: string = window.ffgp?.apiBase ?? import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4780";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (memoryToken) headers.authorization = `Bearer ${memoryToken}`;
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the garage server");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && memoryToken && !path.startsWith("/api/auth/login")) {
      setToken(null);
      window.dispatchEvent(new Event("ffgp:signed-out"));
    }
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const patch = <T,>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const put = <T,>(path: string, body: unknown) => api<T>("PUT", path, body);
