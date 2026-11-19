import type { AiGenerationObserver } from "./ai-observability.ts";
import { OPENAI } from "./constants.ts";
import { LimitedBody } from "./http.ts";

/** Who a generation is attributed to in AI observability. */
export interface Observability {
  observer: AiGenerationObserver;
  distinctId: string;
}

export interface ChatRequest {
  model: string;
  max_completion_tokens: number;
  [field: string]: unknown;
}

/** Why a provider call produced no usable completion. */
export class ProviderError extends Error {
  readonly reason: "http" | "incomplete";

  constructor(reason: "http" | "incomplete") {
    super(
      reason === "http"
        ? "Provider request failed"
        : "Incomplete provider response",
    );
    this.reason = reason;
  }
}

interface ChatOptions {
  /** Names the generation in observability. */
  spanName: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

type Usage = {
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

const SECONDS = 1000;
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * One OpenAI chat completion with structured output. Only metadata reaches
 * observability: never the prompt (task titles, stop reasons) or the
 * generated text, which run without cookie consent.
 */
export class OpenAiChat {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly observability: Observability | undefined;

  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch,
    observability?: Observability,
  ) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.observability = observability;
  }

  /** The completion's text. Throws `ProviderError` or the read's `ApiError`. */
  async complete(body: ChatRequest, options: ChatOptions): Promise<string> {
    const capture = this.capturer(body, options.spanName);
    let httpStatus: number | undefined;
    try {
      const response = await this.fetcher(OPENAI.chatUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError("http");
      }
      const result = JSON.parse(
        await LimitedBody.read(response.body, options.maxResponseBytes),
      );
      const choice = result?.choices?.[0];
      if (
        choice?.finish_reason !== "stop" ||
        choice?.message?.refusal ||
        typeof choice?.message?.content !== "string"
      )
        throw new ProviderError("incomplete");
      capture(result, false, httpStatus);
      return choice.message.content;
    } catch (error) {
      capture(undefined, true, httpStatus);
      throw error;
    }
  }

  /** Captures one generation, once. */
  private capturer(body: ChatRequest, spanName: string) {
    const startedAt = performance.now();
    const observability = this.observability;
    const traceId = observability ? crypto.randomUUID() : undefined;
    let captured = false;
    return (
      result: Usage | undefined,
      isError: boolean,
      httpStatus?: number,
    ) => {
      if (!observability || !traceId || captured) return;
      captured = true;
      observability.observer.capture({
        distinctId: observability.distinctId,
        traceId,
        spanName,
        model: body.model,
        maxTokens: body.max_completion_tokens,
        inputTokens: finite(result?.usage?.prompt_tokens),
        outputTokens: finite(result?.usage?.completion_tokens),
        latency: (performance.now() - startedAt) / SECONDS,
        httpStatus,
        isError,
      });
    };
  }
}
