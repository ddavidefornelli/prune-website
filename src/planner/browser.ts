import {
  createClient,
  type AuthError,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { SUPABASE_ROUTES } from "../shared/api-routes.ts";
import { apiFetch } from "./api-fetch.ts";
import type { CloudTransport } from "./commands.ts";
import type { AuthStatus } from "./types.ts";
import { webConfig, type PublicConfig } from "./config.ts";
import { CloudError, httpError } from "./http-error.ts";
import { hasPrivacyAcknowledgement } from "./privacy-state.ts";
import { logError, networkDetail } from "./error-log.ts";

const SIGN_IN_UNREACHABLE =
  "Couldn't reach sign-in. If you use an ad blocker, VPN, or a work or school network, try turning it off or switching networks, then try again.";

function unreachable(context: string, cause: unknown): CloudError {
  logError("signin_network", context, networkDetail(cause));
  return new CloudError("network", SIGN_IN_UNREACHABLE);
}

function authError(error: AuthError, context: string): CloudError {
  if (error.status === 429)
    return new CloudError(
      "rate_limited",
      "Too many sign-in attempts. Wait at least a minute before trying again.",
    );
  if (error.name === "AuthRetryableFetchError" || !error.status)
    return unreachable(context, error);
  if (error.status >= 500)
    return new CloudError(
      "server",
      "Sign-in services are temporarily unavailable. Please try later or contact support.",
    );
  return new CloudError(
    "auth",
    "Sign-in could not be completed. Check your email and code, or request a new code and try again.",
  );
}

/**
 * Browser transport for the Mac app's existing RPC contract.
 * Supabase manages refresh rotation and cross-tab auth locking. Browser sessions
 * are stored separately from the planner outbox, never in planner snapshots.
 */
export class BrowserCloud implements CloudTransport {
  private client: SupabaseClient | null = null;
  private config: PublicConfig | null = null;
  private accountKey: string | null = null;
  private signingOut = false;
  private invalidated = false;
  private readonly cleanups: (() => void)[] = [];

  async dispose(): Promise<void> {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    await this.client?.auth.stopAutoRefresh();
  }
  onAccountChange: () => void = () => {};

  private sdk(): SupabaseClient {
    if (this.client) return this.client;
    // Constructing the SDK can restore/refresh a saved session. Defer even that
    // until the device-local notice has been durably acknowledged.
    if (!hasPrivacyAcknowledgement(localStorage))
      throw new CloudError(
        "privacy",
        "Accept the Terms & Privacy before continuing.",
      );
    this.config = webConfig();
    this.client = createClient(this.config.url, this.config.publicKey, {
      auth: {
        storageKey: `prune:auth:${this.config.url}`,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
      global: { fetch: apiFetch },
    });
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange((_event, session) => {
      if (!session || this.key(session.user.id) !== this.accountKey)
        this.invalidateAccount();
    });
    const storage = (event: StorageEvent) => {
      if (event.key !== `prune:auth:${this.config!.url}`) return;
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

  private async session(expected = this.accountKey): Promise<Session> {
    const { data, error } = await this.sdk().auth.getSession();
    if (error) throw authError(error, "session");
    if (!data.session)
      throw new CloudError(
        "unauthorized",
        "Your session has expired. Please sign in again.",
      );
    if (expected && this.key(data.session.user.id) !== expected)
      throw new CloudError(
        "account_changed",
        "The account changed. Reload before accessing planner data.",
      );
    return data.session;
  }

  /** A disabled provider would strand the visitor on a raw Supabase error page. */
  private async requireGoogle(): Promise<void> {
    let settings: { external?: { google?: unknown } } | null = null;
    let response: Response;
    try {
      response = await apiFetch(
        `${this.config!.url}${SUPABASE_ROUTES.authSettings}`,
        { headers: { apikey: this.config!.publicKey } },
      );
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw unreachable("google", error);
    }
    try {
      settings = await response.json();
    } catch {
      /* Treated as unavailable below. */
    }
    if (!response.ok || settings?.external?.google !== true)
      throw new CloudError(
        "auth",
        "Google sign-in isn't available right now. Please try again later.",
      );
  }

  private async status(): Promise<AuthStatus> {
    const sdk = this.sdk();
    const callback = new URL(window.location.href);
    // Complete Google redirects started by sign_in_with_google.
    if (callback.searchParams.get("oauth") === "google") {
      const code = callback.searchParams.get("code");
      const failed = callback.searchParams.has("error");
      for (const key of [
        "oauth",
        "code",
        "error",
        "error_code",
        "error_description",
      ]) {
        callback.searchParams.delete(key);
      }
      window.history.replaceState(
        null,
        "",
        callback.pathname + callback.search + callback.hash,
      );
      if (failed || !code) {
        throw new CloudError(
          "auth",
          "Sign-in was cancelled or could not be completed. Please try again.",
        );
      }
      const { error } = await sdk.auth.exchangeCodeForSession(code);
      if (error)
        throw new CloudError(
          "auth",
          "Sign-in could not be completed. Try again in the same browser where you started sign-in.",
        );
    }
    const { data, error } = await sdk.auth.getSession();
    if (error) throw authError(error, "startup");
    if (!data.session)
      return { configured: true, email: null, accountKey: null };
    // Verify identity with Auth before exposing a persistent account cache.
    const result = await sdk.auth.getUser(data.session.access_token);
    if (result.error) {
      if (result.error.status === 401 || result.error.status === 403) {
        await sdk.auth.signOut({ scope: "local" });
        return { configured: true, email: null, accountKey: null };
      }
      throw authError(result.error, "startup");
    }
    const user = result.data.user;
    if (!user.email || user.is_anonymous || user.id !== data.session.user.id)
      throw new CloudError(
        "unauthorized",
        "Sign in with an email account to use prune.",
      );
    const latest = await sdk.auth.getSession();
    if (latest.data.session?.user.id !== user.id)
      throw new CloudError(
        "account_changed",
        "The account changed during startup. Please sign in again.",
      );
    this.accountKey = this.key(user.id);
    return { configured: true, email: user.email, accountKey: this.accountKey };
  }

  private async post<T>(
    route: string,
    body: Record<string, unknown>,
    expected = this.accountKey,
  ): Promise<T> {
    // Capture both identity and bearer token together. An account switch while
    // a request is in flight can never replay the old outbox into a new account.
    const session = await this.session(expected);
    let response: Response;
    try {
      response = await apiFetch(`${this.config!.url}${route}`, {
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
      throw new CloudError(
        "network",
        "Could not reach Supabase. Your pending changes remain on this device and will retry.",
      );
    }
    let value: unknown = null;
    try {
      value = await response.json();
    } catch {
      if (response.ok)
        throw new CloudError(
          "server",
          "The server returned an incomplete response. Your pending changes remain on this device.",
        );
    }
    if (!response.ok)
      throw httpError(
        response.status,
        value,
        route.startsWith("/functions/"),
        body.preview === true,
      );
    return value as T;
  }

  async execute<T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    let result: unknown;
    switch (command) {
      case "auth_status":
        result = await this.status();
        break;
      case "send_code": {
        const { error } = await this.sdk().auth.signInWithOtp({
          email: String(args.email),
        });
        if (error) throw authError(error, "send_code");
        result = null;
        break;
      }
      case "verify_code": {
        const { data, error } = await this.sdk().auth.verifyOtp({
          email: String(args.email),
          token: String(args.code),
          type: "email",
        });
        if (error) throw authError(error, "verify_code");
        if (!data.session || !data.user?.email || data.user.is_anonymous)
          throw new CloudError(
            "auth",
            "The sign-in response was incomplete. Please try again.",
          );
        this.accountKey = this.key(data.user.id);
        result = {
          configured: true,
          email: data.user.email,
          accountKey: this.accountKey,
        };
        break;
      }
      case "sign_in_with_google": {
        const sdk = this.sdk();
        await this.requireGoogle();
        // PKCE: the SDK stores the verifier; status() exchanges the code on return.
        const { data, error } = await sdk.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${window.location.origin}/?oauth=google`,
            skipBrowserRedirect: true,
          },
        });
        if (error || !data.url)
          throw new CloudError(
            "auth",
            "Google sign-in could not be started. Try again or use email instead.",
          );
        window.location.assign(data.url);
        result = null;
        break;
      }
      case "sign_out": {
        this.signingOut = true;
        try {
          const sdk = this.sdk();
          await sdk.auth.stopAutoRefresh();
          await sdk.auth.signOut({ scope: "local" });
          // A failed refresh of an expired offline session can prevent SDK
          // signOut from reaching its local-removal step. Forget that device's
          // credentials explicitly, but never erase a newly switched account.
          const storageKey = `prune:auth:${this.config!.url}`;
          const remaining = localStorage.getItem(storageKey);
          if (remaining) {
            const saved = JSON.parse(remaining) as Session;
            if (!saved.user || this.key(saved.user.id) !== this.accountKey) {
              this.invalidateAccount();
              throw new CloudError(
                "account_changed",
                "The account changed while signing out. Reload before continuing.",
              );
            }
            localStorage.removeItem(storageKey);
          }
          if (localStorage.getItem(storageKey))
            throw new CloudError(
              "storage",
              "Could not clear your browser session. Please try again.",
            );
          this.accountKey = null;
          result = null;
        } finally {
          this.signingOut = false;
        }
        break;
      }
      case "planner_call": {
        const params = args.args as Record<string, unknown>;
        result = await this.post(
          SUPABASE_ROUTES.planner,
          { p_action: args.action, p_args: params, p_timezone: args.timezone },
          typeof params._accountKey === "string"
            ? params._accountKey
            : this.accountKey,
        );
        break;
      }
      case "generate_weekly_review":
        result = await this.post(SUPABASE_ROUTES.weeklyReview, {
          timezone: args.timezone,
          ...(args.preview ? { preview: true } : {}),
        });
        break;
      case "suggest_tasks":
        result = await this.post(SUPABASE_ROUTES.taskSuggestions, {
          timezone: args.timezone,
          target: args.target,
        });
        break;
      default:
        throw new CloudError("validation", "Unsupported browser command.");
    }
    return result as T;
  }
}
