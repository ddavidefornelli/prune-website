import { HTTP_STATUS, SUPABASE_ROUTES } from "../shared/api-routes.ts";
import type { HelperRequest } from "../shared/helper-contract.ts";
import { boundedFetch } from "./api-fetch.ts";
import { SupabaseAuth, type Session } from "./auth.ts";
import { CloudError } from "./cloud-error.ts";
import { PublicConfig } from "./config.ts";
import { MESSAGES } from "./messages.ts";
import { PrivacyNotice } from "./privacy-state.ts";
import type { Account, CloudTransport, Rpc, RpcRequest } from "./types.ts";

const RPC_ROUTES: Record<Rpc, string> = {
  planner_list: SUPABASE_ROUTES.list,
  planner_call: SUPABASE_ROUTES.planner,
};

/** Under the browsers' 64 KB limit for requests that outlive the page. */
const KEEPALIVE_BYTES = 60_000;

/**
 * The browser's transport: Supabase Auth for who this browser is, and the
 * backend's RPCs. Nothing is read or sent before the terms are accepted.
 */
export class BrowserCloud implements CloudTransport {
  private config: PublicConfig | null = null;
  private auth: SupabaseAuth | null = null;
  private accountKey: string | null = null;
  private invalidated = false;
  private readonly cleanups: (() => void)[] = [];
  onAccountChange: () => void = () => {};

  async dispose(): Promise<void> {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
  }

  async identity(create: boolean): Promise<Account | null> {
    const auth = this.client();
    let session: Session | null = await auth.session();
    if (session) {
      let user = await auth.user(session);
      // Refused: try a fresh token before deciding the session is over, so a
      // brief token problem never turns this browser into a new, empty guest.
      if (!user) {
        const renewed = await auth.renew(session);
        if (renewed) {
          session = renewed;
          user = await auth.user(renewed);
        }
      }
      // Removed on the server, or a saved session that disagrees with its
      // own token (never trusted): start again as a new guest.
      if (!user || user.id !== session.user.id) {
        auth.forget();
        session = null;
      } else session = { ...session, user };
    }
    if (!session) {
      if (!create) return null;
      session = await auth.signUpGuest();
    }
    const { user } = session;
    this.accountKey = this.key(user.id);
    return {
      accountKey: this.accountKey,
      email: user.is_anonymous ? null : user.email || null,
      guest: Boolean(user.is_anonymous),
    };
  }

  async signOut(): Promise<void> {
    await this.client().signOut();
    this.accountKey = null;
  }

  async call<T>(rpc: Rpc, accountKey: string, request: RpcRequest): Promise<T> {
    return this.post<T>(
      RPC_ROUTES[rpc],
      accountKey,
      {
        p_action: request.action,
        p_args: request.args,
        p_timezone: request.timezone,
      },
      CloudError.fromResponse,
    );
  }

  async helper<T>(accountKey: string, request: HelperRequest): Promise<T> {
    return this.post<T>(
      SUPABASE_ROUTES.helper,
      accountKey,
      request,
      (status, value) => {
        const body = (value ?? {}) as { code?: unknown; message?: unknown };
        if (status === HTTP_STATUS.unauthorized)
          return new CloudError("unauthorized", MESSAGES.sessionExpired);
        return typeof body.code === "string" && typeof body.message === "string"
          ? new CloudError(body.code, body.message)
          : new CloudError("server", MESSAGES.helperUnavailable);
      },
    );
  }

  async sendCode(email: string): Promise<void> {
    await this.client().sendCode(email);
  }

  async verifyCode(email: string, code: string): Promise<boolean> {
    return this.client().verifyCode(email, code);
  }

  async startGoogle(redirectTo: string): Promise<string> {
    return this.client().googleUrl(redirectTo);
  }

  async finishGoogle(code: string): Promise<boolean> {
    const auth = this.client();
    if (!auth.awaitingGoogle) return false;
    await auth.exchange(code);
    return true;
  }

  /** Posts as `accountKey`, once more with a fresh token if the first is refused. */
  private async post<T>(
    route: string,
    accountKey: string,
    payload: unknown,
    failure: (status: number, value: unknown) => CloudError,
  ): Promise<T> {
    const session = await this.client().session();
    try {
      return await this.send<T>(route, accountKey, payload, session, failure);
    } catch (error) {
      if (CloudError.codeOf(error) !== "unauthorized" || !session) throw error;
      // The token was refused: once, with a fresh one, before giving up.
      return this.send<T>(
        route,
        accountKey,
        payload,
        await this.client().renew(session),
        failure,
      );
    }
  }

  private async send<T>(
    route: string,
    accountKey: string,
    payload: unknown,
    session: Session | null,
    failure: (status: number, value: unknown) => CloudError,
  ): Promise<T> {
    // Identity and bearer token are read together: a request can never carry
    // one account's changes under another account's token.
    if (!session) throw new CloudError("unauthorized", MESSAGES.sessionExpired);
    if (this.key(session.user.id) !== accountKey)
      throw new CloudError("account_changed", MESSAGES.accountChanged);
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await boundedFetch.request(`${this.config!.url}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.config!.publicKey,
          Authorization: `Bearer ${session.access_token}`,
        },
        body,
        // Finishes even when the page is closed mid-request (browsers cap
        // such bodies at 64 KB; a larger one goes as a plain request).
        keepalive: new TextEncoder().encode(body).length < KEEPALIVE_BYTES,
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
    if (!response.ok) throw failure(response.status, value);
    return value as T;
  }

  /** Auth for the configured project, set up only once the terms are accepted. */
  private client(): SupabaseAuth {
    if (this.auth) return this.auth;
    if (!new PrivacyNotice(localStorage).isAcknowledged())
      throw new CloudError("privacy", MESSAGES.privacyRequired);
    this.config = PublicConfig.fromEnvironment();
    const auth = new SupabaseAuth(this.config, localStorage);
    // Another tab signed out, or in as someone else: this tab's list is not
    // that account's to show.
    const changed = (event: StorageEvent) => {
      if (event.key !== auth.storageKey && event.key !== null) return;
      const saved = auth.saved();
      if (!saved || this.key(saved.user.id) !== this.accountKey)
        this.invalidateAccount();
    };
    window.addEventListener("storage", changed);
    this.cleanups.push(() => window.removeEventListener("storage", changed));
    this.auth = auth;
    return auth;
  }

  private invalidateAccount(): void {
    if (!this.accountKey || this.invalidated) return;
    this.invalidated = true;
    queueMicrotask(() => this.onAccountChange());
  }

  private key(userId: string): string {
    return `${this.config!.url}:${userId}`;
  }
}
