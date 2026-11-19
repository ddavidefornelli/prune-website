import {
  createClient,
  type AuthError,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  FUNCTIONS_PREFIX,
  HTTP_STATUS,
  SUPABASE_ROUTES,
} from "../shared/api-routes.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { boundedFetch } from "./api-fetch.ts";
import { CloudError } from "./cloud-error.ts";
import type { CloudTransport } from "./commands.ts";
import { PublicConfig } from "./config.ts";
import { OAUTH_CALLBACK } from "./constants.ts";
import { ErrorReporter, errorReporter } from "./error-log.ts";
import { MESSAGES } from "./messages.ts";
import { PrivacyNotice } from "./privacy-state.ts";
import type { AuthStatus } from "./types.ts";

const SIGNED_OUT: AuthStatus = {
  configured: true,
  email: null,
  accountKey: null,
};

type Args = Record<string, unknown>;

/**
 * Browser transport for the planner's RPC contract. Supabase manages refresh
 * rotation and cross-tab auth locking. Browser sessions are stored separately
 * from the planner outbox, never in planner snapshots.
 */
export class BrowserCloud implements CloudTransport {
  private client: SupabaseClient | null = null;
  private config: PublicConfig | null = null;
  private accountKey: string | null = null;
  private signingOut = false;
  private invalidated = false;
  private readonly cleanups: (() => void)[] = [];
  onAccountChange: () => void = () => {};

  async dispose(): Promise<void> {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    await this.client?.auth.stopAutoRefresh();
  }

  async execute<T>(command: string, args: Args = {}): Promise<T> {
    switch (command) {
      case "auth_status":
        return (await this.status()) as T;
      case "send_code":
        return (await this.sendCode(String(args.email))) as T;
      case "verify_code":
        return (await this.verifyCode(
          String(args.email),
          String(args.code),
        )) as T;
      case "sign_in_with_google":
        return (await this.signInWithGoogle()) as T;
      case "sign_out":
        return (await this.signOut()) as T;
      case "planner_call": {
        const params = args.args as Args;
        return this.post<T>(
          SUPABASE_ROUTES.planner,
          { p_action: args.action, p_args: params, p_timezone: args.timezone },
          typeof params._accountKey === "string"
            ? params._accountKey
            : this.accountKey,
        );
      }
      case "planner_schedule":
        return this.post<T>(SUPABASE_ROUTES.schedule, {
          p_action: args.action,
          p_args: args.args,
          p_timezone: args.timezone,
        });
      case "planner_track":
        return this.post<T>(SUPABASE_ROUTES.track, {
          p_event: args.event,
          p_detail: args.detail,
        });
      case "generate_weekly_review":
        return this.post<T>(SUPABASE_ROUTES.weeklyReview, {
          timezone: args.timezone,
        });
      case "suggest_tasks":
        return this.post<T>(SUPABASE_ROUTES.taskSuggestions, {
          timezone: args.timezone,
          target: args.target,
        });
      default:
        throw new CloudError("validation", MESSAGES.unsupportedCommand);
    }
  }

  private get authStorageKey(): string {
    return STORAGE_KEYS.auth(this.config!.url);
  }

  private sdk(): SupabaseClient {
    if (this.client) return this.client;
    // Constructing the SDK can restore/refresh a saved session. Defer even that
    // until the device-local notice has been durably acknowledged.
    if (!new PrivacyNotice(localStorage).isAcknowledged())
      throw new CloudError("privacy", MESSAGES.privacyRequired);
    this.config = PublicConfig.fromEnvironment();
    this.client = createClient(this.config.url, this.config.publicKey, {
      auth: {
        storageKey: this.authStorageKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
      global: { fetch: boundedFetch.fetch },
    });
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange((_event, session) => {
      if (!session || this.key(session.user.id) !== this.accountKey)
        this.invalidateAccount();
    });
    const storage = (event: StorageEvent) => {
      if (event.key !== this.authStorageKey) return;
      try {
        const saved = event.newValue
          ? (JSON.parse(event.newValue) as Session)
          : null;
        if (!saved?.user || this.key(saved.user.id) !== this.accountKey)
          this.invalidateAccount();
      } catch {
        this.invalidateAccount();
      }
    };
    window.addEventListener("storage", storage);
    this.cleanups.push(() => {
      subscription.unsubscribe();
      window.removeEventListener("storage", storage);
    });
    return this.client;
  }

  private invalidateAccount(): void {
    if (!this.accountKey || this.signingOut || this.invalidated) return;
    this.invalidated = true;
    // No SDK calls/await inside an auth event handler.
    queueMicrotask(() => this.onAccountChange());
  }

  private key(userId: string): string {
    return `${this.config!.url}:${userId}`;
  }

  private static unreachable(context: string, cause: unknown): CloudError {
    errorReporter.report(
      "signin_network",
      context,
      ErrorReporter.networkFailure(cause),
    );
    return new CloudError("network", MESSAGES.signInUnreachable);
  }

  private static authError(error: AuthError, context: string): CloudError {
    if (error.status === HTTP_STATUS.tooManyRequests)
      return new CloudError("rate_limited", MESSAGES.signInRateLimited);
    if (error.name === "AuthRetryableFetchError" || !error.status)
      return BrowserCloud.unreachable(context, error);
    if (error.status >= HTTP_STATUS.serverError)
      return new CloudError("server", MESSAGES.signInUnavailable);
    return new CloudError("auth", MESSAGES.signInFailed);
  }

  private async session(expected = this.accountKey): Promise<Session> {
    const { data, error } = await this.sdk().auth.getSession();
    if (error) throw BrowserCloud.authError(error, "session");
    if (!data.session)
      throw new CloudError("unauthorized", MESSAGES.sessionExpired);
    if (expected && this.key(data.session.user.id) !== expected)
      throw new CloudError("account_changed", MESSAGES.accountChanged);
    return data.session;
  }

  /** A disabled provider would strand the visitor on a raw Supabase error page. */
  private async requireGoogle(): Promise<void> {
    let settings: { external?: { google?: unknown } } | null = null;
    let response: Response;
    try {
      response = await boundedFetch.request(
        `${this.config!.url}${SUPABASE_ROUTES.authSettings}`,
        { headers: { apikey: this.config!.publicKey } },
      );
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw BrowserCloud.unreachable("google", error);
    }
    try {
      settings = await response.json();
    } catch {
      /* Treated as unavailable below. */
    }
    if (!response.ok || settings?.external?.google !== true)
      throw new CloudError("auth", MESSAGES.googleUnavailable);
  }

  /** Completes a Google redirect started by `sign_in_with_google`, if this is one. */
  private async completeGoogleRedirect(sdk: SupabaseClient): Promise<void> {
    const callback = new URL(window.location.href);
    if (
      callback.searchParams.get(OAUTH_CALLBACK.marker) !==
      OAUTH_CALLBACK.provider
    )
      return;
    const code = callback.searchParams.get(OAUTH_CALLBACK.code);
    const failed = callback.searchParams.has(OAUTH_CALLBACK.error);
    for (const key of OAUTH_CALLBACK.params) callback.searchParams.delete(key);
    window.history.replaceState(
      null,
      "",
      callback.pathname + callback.search + callback.hash,
    );
    if (failed || !code) throw new CloudError("auth", MESSAGES.signInCancelled);
    const { error } = await sdk.auth.exchangeCodeForSession(code);
    if (error) throw new CloudError("auth", MESSAGES.signInOtherBrowser);
  }

  private async status(): Promise<AuthStatus> {
    const sdk = this.sdk();
    await this.completeGoogleRedirect(sdk);
    const { data, error } = await sdk.auth.getSession();
    if (error) throw BrowserCloud.authError(error, "startup");
    if (!data.session) return SIGNED_OUT;
    // Verify identity with Auth before exposing a persistent account cache.
    const result = await sdk.auth.getUser(data.session.access_token);
    if (result.error) {
      if (
        result.error.status === HTTP_STATUS.unauthorized ||
        result.error.status === HTTP_STATUS.forbidden
      ) {
        await sdk.auth.signOut({ scope: "local" });
        return SIGNED_OUT;
      }
      throw BrowserCloud.authError(result.error, "startup");
    }
    const user = result.data.user;
    if (!user.email || user.is_anonymous || user.id !== data.session.user.id)
      throw new CloudError("unauthorized", MESSAGES.emailAccountRequired);
    const latest = await sdk.auth.getSession();
    if (latest.data.session?.user.id !== user.id)
      throw new CloudError("account_changed", MESSAGES.accountChangedAtStartup);
    this.accountKey = this.key(user.id);
    return { configured: true, email: user.email, accountKey: this.accountKey };
  }

  private async sendCode(email: string): Promise<null> {
    const { error } = await this.sdk().auth.signInWithOtp({ email });
    if (error) throw BrowserCloud.authError(error, "send_code");
    return null;
  }

  private async verifyCode(email: string, code: string): Promise<AuthStatus> {
    const { data, error } = await this.sdk().auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) throw BrowserCloud.authError(error, "verify_code");
    if (!data.session || !data.user?.email || data.user.is_anonymous)
      throw new CloudError("auth", MESSAGES.signInIncomplete);
    this.accountKey = this.key(data.user.id);
    return {
      configured: true,
      email: data.user.email,
      accountKey: this.accountKey,
    };
  }

  /** PKCE: the SDK stores the verifier; `status()` exchanges the code on return. */
  private async signInWithGoogle(): Promise<null> {
    const sdk = this.sdk();
    await this.requireGoogle();
    const { data, error } = await sdk.auth.signInWithOAuth({
      provider: OAUTH_CALLBACK.provider,
      options: {
        redirectTo: `${window.location.origin}/?${OAUTH_CALLBACK.marker}=${OAUTH_CALLBACK.provider}`,
        skipBrowserRedirect: true,
      },
    });
    if (error || !data.url)
      throw new CloudError("auth", MESSAGES.googleNotStarted);
    window.location.assign(data.url);
    return null;
  }

  private async signOut(): Promise<null> {
    this.signingOut = true;
    try {
      const sdk = this.sdk();
      await sdk.auth.stopAutoRefresh();
      await sdk.auth.signOut({ scope: "local" });
      // A failed refresh of an expired offline session can prevent SDK
      // signOut from reaching its local-removal step. Forget that device's
      // credentials explicitly, but never erase a newly switched account.
      const remaining = localStorage.getItem(this.authStorageKey);
      if (remaining) {
        const saved = JSON.parse(remaining) as Session;
        if (!saved.user || this.key(saved.user.id) !== this.accountKey) {
          this.invalidateAccount();
          throw new CloudError(
            "account_changed",
            MESSAGES.accountChangedAtSignOut,
          );
        }
        localStorage.removeItem(this.authStorageKey);
      }
      if (localStorage.getItem(this.authStorageKey))
        throw new CloudError("storage", MESSAGES.signOutStorage);
      this.accountKey = null;
      return null;
    } finally {
      this.signingOut = false;
    }
  }

  private async post<T>(
    route: string,
    body: Args,
    expected = this.accountKey,
  ): Promise<T> {
    // Capture both identity and bearer token together. An account switch while
    // a request is in flight can never replay the old outbox into a new account.
    const session = await this.session(expected);
    let response: Response;
    try {
      response = await boundedFetch.request(`${this.config!.url}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.config!.publicKey,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError("network", MESSAGES.unreachable);
    }
    let value: unknown = null;
    try {
      value = await response.json();
    } catch {
      if (response.ok)
        throw new CloudError("server", MESSAGES.incompleteResponse);
    }
    if (!response.ok)
      throw CloudError.fromResponse(
        response.status,
        value,
        route.startsWith(FUNCTIONS_PREFIX),
      );
    return value as T;
  }
}
