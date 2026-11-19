import { PostHog } from "npm:posthog-node";
import type { AiGenerationObserver } from "../../server/ai-observability.ts";
import { OPENAI } from "../../server/constants.ts";

type Generation = Parameters<AiGenerationObserver["capture"]>[0];

const ENV_NAMES = { key: "VITE_POSTHOG_KEY", host: "VITE_POSTHOG_HOST" } as const;

const missingConfiguration = (name: string) =>
  `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`;

/** Non-blocking manual AI Observability capture for Supabase Edge Functions. */
export class PostHogAiObserver implements AiGenerationObserver {
  private readonly client: PostHog;

  private constructor(projectToken: string, host: string) {
    this.client = new PostHog(projectToken, {
      host,
      privacyMode: true,
      enableExceptionAutocapture: false,
      flushAt: 1,
    });
  }

  /** None without a PostHog key and host; outside production it says which is missing. */
  static create(
    projectToken: string | undefined,
    host: string | undefined,
    isProduction: boolean,
  ): PostHogAiObserver | undefined {
    if (projectToken && host) return new PostHogAiObserver(projectToken, host);
    if (!isProduction)
      console.warn(
        missingConfiguration(!projectToken ? ENV_NAMES.key : ENV_NAMES.host),
      );
    return undefined;
  }

  capture(generation: Generation): void {
    const { inputTokens, outputTokens, httpStatus, isError } = generation;
    try {
      this.client.capture({
        distinctId: generation.distinctId,
        event: "$ai_generation",
        properties: {
          $ai_trace_id: generation.traceId,
          $ai_session_id: null,
          $ai_span_id: crypto.randomUUID(),
          $ai_span_name: generation.spanName,
          $ai_model: generation.model,
          $ai_provider: OPENAI.provider,
          ...(inputTokens === undefined ? {} : { $ai_input_tokens: inputTokens }),
          ...(outputTokens === undefined
            ? {}
            : { $ai_output_tokens: outputTokens }),
          $ai_latency: generation.latency,
          ...(httpStatus === undefined ? {} : { $ai_http_status: httpStatus }),
          $ai_max_tokens: generation.maxTokens,
          ...(isError ? { $ai_is_error: true, $ai_error: "generation_failed" } : {}),
        },
      });
    } catch {
      // Analytics must never affect the AI response.
    }
  }
}
