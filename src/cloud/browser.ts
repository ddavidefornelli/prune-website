import { SUPABASE_ROUTES } from "../shared/api-routes.ts";
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
      const user = await auth.user(session);
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
    // Identity and bearer token are read together: a request can never carry
    // one account's changes under another account's token.
    const session = await this.client().session();
    if (!session) throw new CloudError("unauthorized", MESSAGES.sessionExpired);
    if (this.key(session.user.id) !== accountKey)
      throw new CloudError("account_changed", MESSAGES.accountChanged);
    let response: Response;
    try {
      response = await boundedFetch.request(
        `${this.config!.url}${RPC_ROUTES[rpc]}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: this.config!.publicKey,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            p_action: request.action,
            p_args: request.args,
            p_timezone: request.timezone,
          }),
        },
      );
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
