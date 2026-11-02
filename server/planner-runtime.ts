import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import { createPlannerHandler } from "./planner-handler.ts";
import { ApiError } from "./http.ts";
import { resolveClerkIdentity, type IdentityStore } from "./clerk-identity.ts";
import { createHandler as createReviewHandler } from "./weekly-review/handler.ts";
import { generateReview, MODEL } from "./weekly-review/provider.ts";

export function plannerRuntime(env: Record<string, string | undefined>) {
  const origins = new Set(
    (
      env.APP_ORIGINS ||
      "https://www.prune.win,http://localhost:5173,http://127.0.0.1:5173"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  // Lazily initialized: an unconfigured local checkout can still show sign-in.
  const createPlatform = () => {
    if (
      !env.CLERK_SECRET_KEY ||
      !env.VITE_CLERK_PUBLISHABLE_KEY ||
      !env.VITE_SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    )
      throw new Error("Server configuration missing");
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
    });
    const db = createClient(
      env.VITE_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.timeout(20_000),
              redirect: "error",
            }),
        },
      },
    );
    async function rpc<T>(
      name: string,
      args: Record<string, unknown>,
    ): Promise<T> {
      const { data, error } = await db.rpc(name, args);
      if (error) {
        const safe = ["PT400", "PT404", "PT409", "PT401", "PT403"].includes(
          error.code,
        );
        if (safe)
          throw new ApiError(
            error.code === "PT401" ? 401 : error.code === "PT403" ? 403 : 400,
            error.code,
            error.message.slice(0, 299),
          );
        throw new Error("Database request failed");
      }
      return data as T;
    }
    const store: IdentityStore = {
      async lookup(subject) {
        const { data, error } = await db
          .from("planner_clerk_identities")
          .select("user_id")
          .eq("clerk_subject", subject)
          .maybeSingle();
        if (error) throw new Error("Identity migration missing");
        return data?.user_id ?? null;
      },
      async existing(userId) {
        const { data, error } = await db.auth.admin.getUserById(userId);
        if (error) throw new Error("Account lookup failed");
        return data.user;
      },
      async create(email) {
        const { data, error } = await db.auth.admin.createUser({
          email,
          email_confirm: true,
          app_metadata: { provisioned_by: "clerk" },
        });
        if (error || !data.user) throw new Error("Account provisioning failed");
        return data.user.id;
      },
      async link(subject, userId) {
        const { error } = await db
          .from("planner_clerk_identities")
          .insert({ clerk_subject: subject, user_id: userId });
        if (error && (await store.lookup(subject)) !== userId)
          throw new Error("Identity conflict");
      },
    };
    return { clerk, store, rpc };
  };
  let services: ReturnType<typeof createPlatform> | undefined;
  const platform = () => (services ??= createPlatform());

  return createPlannerHandler({
    allowedOrigins: origins,
    async authenticate(request) {
      if (!/^Bearer [^\s]+$/i.test(request.headers.get("Authorization") ?? ""))
        throw new ApiError(401, "unauthorized", "Sign in to use prune.");
      const { clerk, store } = platform();
      const result = await clerk.authenticateRequest(request, {
        authorizedParties: [...origins],
      });
      const auth = result.toAuth();
      if (!auth?.userId)
        throw new ApiError(
          401,
          "unauthorized",
          "Your session has expired. Sign in again.",
        );
      const user = await clerk.users.getUser(auth.userId);
      // Separate dev/prod and different Clerk applications even for equal IDs.
      return resolveClerkIdentity(env.VITE_CLERK_PUBLISHABLE_KEY!, user, store);
    },
    async planner(identity, action, args, timezone) {
      return platform().rpc("planner_call_as", {
        p_user_id: identity.userId,
        p_action: action,
        p_args: args,
        p_timezone: timezone,
      });
    },
    async review(request, identity, args) {
      if (
        typeof args.timezone !== "string" ||
        (args.preview !== undefined && typeof args.preview !== "boolean") ||
        Object.keys(args).some((key) => !["timezone", "preview"].includes(key))
      )
        throw new ApiError(400, "invalid_request", "Invalid review request.");
      const { rpc } = platform();
      // Enforce the same soft-delete guard before any service-only review loader.
      await rpc("planner_call_as", {
        p_user_id: identity.userId,
        p_action: "dashboard",
        p_args: {},
        p_timezone: args.timezone,
      });
      const handler = createReviewHandler({
        authenticate: async () => identity.userId, // verified above, scoped to THIS request
        loadInput: (userId, timezone, preview) =>
          rpc(preview ? "planner_preview_input" : "planner_review_input", {
            p_user_id: userId,
            p_timezone: timezone,
          }),
        loadWeekGoal: (userId, weekStart) =>
          rpc("planner_week_goal", {
            p_user_id: userId,
            p_week_start: weekStart,
          }),
        reserve: (userId, input, hash, preview) =>
          rpc(
            preview ? "reserve_review_preview" : "reserve_planner_review",
            preview
              ? { p_user_id: userId }
              : {
                  p_user_id: userId,
                  p_week_start: input.weekStart,
                  p_request_hash: hash,
                  p_consent_version: input.consentVersion,
                  p_activity: input.activity,
                },
          ),
        generate: async (input) => {
          if (!env.OPENAI_API_KEY) throw new Error("AI is not configured");
          return generateReview(input, env.OPENAI_API_KEY);
        },
        finish: (id, token, analysis, preview) =>
          rpc(preview ? "finish_review_preview" : "finish_weekly_review", {
            p_id: id,
            p_lease_token: token,
            ...(preview ? {} : { p_analysis: analysis, p_model: MODEL }),
          }),
        fail: async (id, token, preview) => {
          await rpc(preview ? "fail_review_preview" : "fail_weekly_review", {
            p_id: id,
            p_lease_token: token,
          });
        },
        now: () => new Date(),
        allowedOrigins: origins,
      });
      return handler(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(args),
        }),
      );
    },
  });
}
