// Thin fetch wrapper for the server API (Vite proxies /api → :8787).

export class ApiError extends Error {
  /** 0 = network failure (server unreachable). */
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** Worth offering a Retry: the server was unreachable or broke, not a bad request. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // No JSON body on a 5xx = the Vite proxy couldn't reach the API server.
    const msg = json && typeof json.error === "string" ? json.error
      : res.status >= 500 ? "Can't reach the server." : `Server error (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}
