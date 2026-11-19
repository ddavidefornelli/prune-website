import { PostHog } from "npm:posthog-node";
import type { AiGenerationObserver } from "../../server/ai-observability.ts";

const missingConfiguration = (name: string) =>
  `${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured`;

/** Non-blocking manual AI Observability capture for Supabase Edge Functions. */
export function createAiGenerationObserver(
  projectToken: string | undefined,
  host: string | undefined,
  isProduction: boolean,
): AiGenerationObserver | undefined {
  const missing = !projectToken
    ? "VITE_POSTHOG_KEY"
    : !host
      ? "VITE_POSTHOG_HOST"
      : undefined;
  if (missing) {
    if (!isProduction) console.warn(missingConfiguration(missing));
    return undefined;
  }

  const client = new PostHog(projectToken, {
    host,
    privacyMode: true,
    enableExceptionAutocapture: false,
    flushAt: 1,
  });

  return {
    capture({
      distinctId,
      traceId,
      spanName,
      model,
      maxTokens,
      inputTokens,
      outputTokens,
      latency,
      httpStatus,
      isError,
    }) {
      try {
        client.capture({
          distinctId,
          event: "$ai_generation",
          properties: {
            $ai_trace_id: traceId,
            $ai_session_id: null,
            $ai_span_id: crypto.randomUUID(),
            $ai_span_name: spanName,
            $ai_model: model,
            $ai_provider: "openai",
            ...(inputTokens === undefined
              ? {}
              : { $ai_input_tokens: inputTokens }),
            ...(outputTokens === undefined
              ? {}
              : { $ai_output_tokens: outputTokens }),
            $ai_latency: latency,
            ...(httpStatus === undefined
              ? {}
              : { $ai_http_status: httpStatus }),
            $ai_max_tokens: maxTokens,
            ...(isError
              ? { $ai_is_error: true, $ai_error: "generation_failed" }
              : {}),
          },
        });
      } catch {
        // Analytics must never affect the AI response.
      }
    },
  };
}
