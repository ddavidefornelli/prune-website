/** Metadata-only AI generation capture: no prompt or output text. */
export type AiGenerationObserver = {
  capture(generation: {
    distinctId: string;
    traceId: string;
    spanName: string;
    model: string;
    maxTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    latency: number;
    httpStatus?: number;
    isError: boolean;
  }): void;
};
