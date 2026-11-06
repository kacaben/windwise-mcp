/**
 * Thin HTTP layer shared by every Open-Meteo endpoint.
 *
 * Responsibilities:
 * - request timeouts (Open-Meteo is fast; a hung socket should not hang the agent)
 * - one retry on transient failures (network errors, 429, 5xx)
 * - turning Open-Meteo's `{ error: true, reason }` payloads into typed errors
 */

export const USER_AGENT = "windwise-mcp/0.1.0";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** Base delay between retries; doubled on each attempt. */
  retryDelayMs?: number;
}

export type OpenMeteoErrorKind = "bad_request" | "upstream" | "timeout" | "network";

export class OpenMeteoError extends Error {
  constructor(
    message: string,
    readonly kind: OpenMeteoErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenMeteoError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (!(error instanceof OpenMeteoError)) return false;
  if (error.kind === "network" || error.kind === "timeout") return true;
  return error.kind === "upstream" && (error.status === 429 || (error.status ?? 0) >= 500);
}

async function fetchOnce<T>(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new OpenMeteoError(`Open-Meteo did not respond within ${timeoutMs} ms`, "timeout");
    }
    throw new OpenMeteoError(`Could not reach Open-Meteo: ${(error as Error).message}`, "network");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenMeteoError(
      `Open-Meteo returned a non-JSON response (HTTP ${response.status})`,
      "upstream",
      response.status,
    );
  }

  const reason =
    body && typeof body === "object" && (body as { error?: unknown }).error === true
      ? String((body as { reason?: unknown }).reason ?? "unknown error")
      : undefined;

  if (!response.ok || reason) {
    const kind: OpenMeteoErrorKind = response.status === 400 ? "bad_request" : "upstream";
    throw new OpenMeteoError(
      `Open-Meteo request failed (HTTP ${response.status}): ${reason ?? response.statusText}`,
      kind,
      response.status,
    );
  }

  return body as T;
}

export async function getJson<T>(
  baseUrl: string,
  params: Record<string, string | number | boolean | readonly string[] | undefined>,
  options: HttpOptions = {},
): Promise<T> {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }

  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce<T>(url.toString(), fetchImpl, timeoutMs);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}
