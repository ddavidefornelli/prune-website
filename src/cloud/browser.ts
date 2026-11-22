import {
  createClient,
  type AuthError,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { HTTP_STATUS, SUPABASE_ROUTES } from "../shared/api-routes.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { boundedFetch } from "./api-fetch.ts";
import { CloudError } from "./cloud-error.ts";
import { PublicConfig } from "./config.ts";
import { ErrorReporter, errorReporter } from "./error-log.ts";
import { MESSAGES } from "./messages.ts";
import { PrivacyNotice } from "./privacy-state.ts";
import type { Account, CloudTransport } from "./types.ts";

type Args = Record<string, unknown>;

/**
 * Browser transport for the backend's RPC contract. Supabase manages refresh
 * rotation and cross-tab auth locking. Browser sessions are stored separately
 * from the saved list, never inside it.
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
      case "identity":
        return (await this.identity(args.create !== false)) as T;
      case "sign_out":
        return (await this.signOut()) as T;
      case "planner_call":
        return this.rpc<T>(SUPABASE_ROUTES.planner, args);
      case "planner_list":
        return this.rpc<T>(SUPABASE_ROUTES.list, args);
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
    return new CloudError("network", MESSAGES.unreachable);
  }

  private static authError(error: AuthError, context: string): CloudError {
    if (error.status === HTTP_STATUS.tooManyRequests)
      return new CloudError("rate_limited", MESSAGES.rateLimited);
    if (error.name === "AuthRetryableFetchError" || !error.status)
      return BrowserCloud.unreachable(context, error);
    if (error.status >= HTTP_STATUS.serverError)
      return new CloudError("server", MESSAGES.serverFailed);
    return new CloudError("auth", MESSAGES.guestUnavailable);
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

  /**
   * Whose list this browser syncs: the saved session, checked with Auth, or,
   * when there is none (or the server no longer knows it) and `create` is
   * set, a new guest (Supabase's anonymous sign-in). Null otherwise.
   */
  private async identity(create: boolean): Promise<Account | null> {
    const sdk = this.sdk();
    const saved = await sdk.auth.getSession();
    if (saved.error) throw BrowserCloud.authError(saved.error, "session");
    let session = saved.data.session;
    if (session) {
      const checked = await sdk.auth.getUser(session.access_token);
      if (checked.error) {
        if (
          checked.error.status !== HTTP_STATUS.unauthorized &&
          checked.error.status !== HTTP_STATUS.forbidden
        )
          throw BrowserCloud.authError(checked.error, "session");
        // Removed on the server: start again as a new guest.
        await sdk.auth.signOut({ scope: "local" });
        session = null;
      } else if (checked.data.user.id !== session.user.id) {
        // A saved session that disagrees with its own token is never trusted.
        await sdk.auth.signOut({ scope: "local" });
        session = null;
      } else session = { ...session, user: checked.data.user };
    }
    if (!session) {
      if (!create) return null;
      const created = await sdk.auth.signInAnonymously();
      if (created.error) throw BrowserCloud.authError(created.error, "guest");
      if (!created.data.session)
        throw new CloudError("auth", MESSAGES.guestUnavailable);
      session = created.data.session;
    }
    const user = session.user;
    this.accountKey = this.key(user.id);
    return {
      accountKey: this.accountKey,
      email: user.is_anonymous ? null : user.email || null,
      guest: Boolean(user.is_anonymous),
    };
  }

  /** Forgets this browser's session (after Delete everything). */
  private async signOut(): Promise<null> {
    this.signingOut = true;
    try {
      const sdk = this.sdk();
      await sdk.auth.stopAutoRefresh();
      await sdk.auth.signOut({ scope: "local" });
      // A failed refresh of an expired offline session can prevent SDK
      // signOut from reaching its local-removal step: remove it explicitly.
      localStorage.removeItem(this.authStorageKey);
      if (localStorage.getItem(this.authStorageKey))
        throw new CloudError("storage", MESSAGES.signOutStorage);
      this.accountKey = null;
      return null;
    } finally {
      this.signingOut = false;
    }
  }

  /** `args.args._accountKey`, when set, is the account the caller expects; it stays in the browser. */
  private rpc<T>(route: string, args: Args): Promise<T> {
    const { _accountKey: expected, ...params } = args.args as Args;
    return this.post<T>(
      route,
      { p_action: args.action, p_args: params, p_timezone: args.timezone },
      typeof expected === "string" ? expected : this.accountKey,
    );
  }

  private async post<T>(
    route: string,
    body: Args,
    expected = this.accountKey,
  ): Promise<T> {
    // Capture both identity and bearer token together: a request can never
    // carry one account's changes under another account's token.
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
    if (!response.ok) throw CloudError.fromResponse(response.status, value);
    return value as T;
  }
}
