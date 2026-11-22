import { HTTP_LIMITS, SUPABASE_ROUTES } from "../shared/api-routes.ts";
import { CloudError } from "./cloud-error.ts";
import { MESSAGES } from "./messages.ts";

type Limits = { [Key in keyof typeof HTTP_LIMITS]: number };

/**
 * `fetch` with a deadline that covers the streamed body and a cap on its
 * size. Never sends cookies or a referrer, and never follows a redirect.
 */
export class BoundedFetch {
  private readonly limits: Limits;

  constructor(limits: Limits = HTTP_LIMITS) {
    this.limits = limits;
  }

  /** The `fetch`-compatible form the Supabase SDK takes. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    this.request(input, init);

  async request(
    input: RequestInfo | URL,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const url = input instanceof Request ? input.url : String(input);
    const timeout = setTimeout(abort, timeoutMs ?? this.timeoutFor(url));
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      return await this.buffer(response, controller.signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private timeoutFor(url: string): number {
    if (url.includes(SUPABASE_ROUTES.signOut)) return this.limits.signOutMs;
    return this.limits.requestMs;
  }

  /** Reads the whole body under the deadline and size cap, then rebuilds it. */
  private async buffer(
    response: Response,
    signal: AbortSignal,
  ): Promise<Response> {
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let length = 0;
    let rejectRead!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectRead = reject;
    });
    const interrupt = () => {
      rejectRead(signal.reason);
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    try {
      while (true) {
        const { value, done } = await Promise.race([
          reader.read(),
          interrupted,
        ]);
        if (done) break;
        length += value.byteLength;
        if (length > this.limits.responseBytes) {
          // Cancellation is best-effort; a broken stream must not delay failure.
          void reader.cancel().catch(() => {});
          throw new CloudError("size", MESSAGES.responseTooLarge);
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", interrupt);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export const boundedFetch = new BoundedFetch();
