export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason the app reacts to, e.g. "device_not_paired". */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "Please sign in") => new HttpError(401, m);
export const forbidden = (m = "You don't have permission to do that") => new HttpError(403, m);
export const notFound = (m = "Not found") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const tooManyRequests = (m: string) => new HttpError(429, m);
