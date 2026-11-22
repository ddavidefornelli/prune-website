import { HTTP_STATUS, SUPABASE_ROUTES } from "../shared/api-routes.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { TIME } from "../shared/time-constants.ts";
import { boundedFetch, type BoundedFetch } from "./api-fetch.ts";
import { CloudError } from "./cloud-error.ts";
import type { PublicConfig } from "./config.ts";
import { ErrorReporter, errorReporter } from "./error-log.ts";
import { MESSAGES } from "./messages.ts";

/** Who a session belongs to, as Supabase Auth describes the user. */
export interface AuthUser {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
}

/**
 * A Supabase Auth session, saved in the shape supabase-js saved it, so the
 * sessions earlier versions of the site kept go on working. Other fields Auth
 * sends are kept as they are.
 */
export interface Session {
  access_token: string;
  refresh_token: string;
  /** When the access token expires, in epoch seconds. */
  expires_at: number;
  user: AuthUser;
}

type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface AuthRequest {
  method: "GET" | "POST";
  /** The session's access token; requests without one carry only the project key. */
  token?: string;
  body?: Record<string, unknown>;
  /** Why the request is made, for the error log. Unset: failures are not reported. */
  context?: string;
}

const AUTH = {
  /** Refresh this long before the access token expires, as supabase-js did. */
  refreshMarginMs: 90 * TIME.msPerSecond,
  /** New-format keys are not JWTs: they go in the apikey header only. */
  publishableKeyPrefix: "sb_publishable_",
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Supabase Auth for one project, over plain HTTP: the saved session and its
 * refresh, the server's check of it, a new guest (anonymous sign-up) and
 * signing out. The session is kept in localStorage under its own key, never
 * inside the saved list.
 */
export class SupabaseAuth {
  readonly storageKey: string;
  private readonly config: PublicConfig;
  private readonly storage: AuthStorage;
  private readonly http: BoundedFetch;
  private refreshing: Promise<Session | null> | null = null;

  constructor(
    config: PublicConfig,
    storage: AuthStorage,
    http: BoundedFetch = boundedFetch,
  ) {
    this.config = config;
    this.storage = storage;
    this.http = http;
    this.storageKey = STORAGE_KEYS.auth(config.url);
  }

  /** A session from Auth's answer or from storage; null unless well-formed. */
  static parse(value: unknown): Session | null {
    if (
      !isObject(value) ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      !SupabaseAuth.isUser(value.user)
    )
      return null;
    const expiresAt =
      typeof value.expires_at === "number"
        ? value.expires_at
        : typeof value.expires_in === "number"
          ? Math.round(Date.now() / TIME.msPerSecond) + value.expires_in
          : NaN;
    if (!Number.isFinite(expiresAt)) return null;
    return { ...value, expires_at: expiresAt } as Session;
  }

  private static isUser(value: unknown): value is AuthUser {
    return isObject(value) && typeof value.id === "string" && !!value.id;
  }

  /** The saved session, if there is a well-formed one. */
  saved(): Session | null {
    try {
      return SupabaseAuth.parse(
        JSON.parse(this.storage.getItem(this.storageKey) ?? "null"),
      );
    } catch {
      return null;
    }
  }

  /**
   * The saved session with an access token good for a while yet, refreshed
   * when it is about to expire. Null when there is none, or when the server
   * ended it.
   */
  async session(): Promise<Session | null> {
    const saved = this.saved();
    if (!saved || !SupabaseAuth.expiring(saved)) return saved;
    this.refreshing ??= this.locked(() => this.refresh()).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * A new access token even though this one looks fresh: the server refused
   * it (a device clock running behind, say). Null when the session is over.
   */
  async renew(session: Session): Promise<Session | null> {
    this.refreshing ??= this.locked(() =>
      this.refresh(session.refresh_token),
    ).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The user the server sees behind the session, or null when it no longer knows them. */
  async user(session: Session): Promise<AuthUser | null> {
    const response = await this.send(SUPABASE_ROUTES.user, {
      method: "GET",
      token: session.access_token,
      context: "session",
    });
    if (
      response.status === HTTP_STATUS.unauthorized ||
      response.status === HTTP_STATUS.forbidden
    )
      return null;
    if (!response.ok) throw SupabaseAuth.failure(response.status);
    const user = await SupabaseAuth.json(response);
    if (!SupabaseAuth.isUser(user))
      throw new CloudError("server", MESSAGES.incompleteResponse);
    return user;
  }

  /** A new guest (Supabase's anonymous sign-up), saved as this browser's session. */
  async signUpGuest(): Promise<Session> {
    const response = await this.send(SUPABASE_ROUTES.signUp, {
      method: "POST",
      body: { data: {} },
      context: "guest",
    });
    if (!response.ok) throw SupabaseAuth.failure(response.status);
    const session = SupabaseAuth.parse(await SupabaseAuth.json(response));
    if (!session) throw new CloudError("auth", MESSAGES.guestUnavailable);
    this.save(session);
    return session;
  }

  /** Forgets this browser's session, telling the server when it can. */
  async signOut(): Promise<void> {
    const saved = this.saved();
    if (saved)
      await this.send(`${SUPABASE_ROUTES.signOut}?scope=local`, {
        method: "POST",
        token: saved.access_token,
      }).catch(() => {});
    this.forget();
    if (this.storage.getItem(this.storageKey) !== null)
      throw new CloudError("storage", MESSAGES.signOutStorage);
  }

  /** Removes the saved session from this browser only. */
  forget(): void {
    this.storage.removeItem(this.storageKey);
    // supabase-js kept Google sign-in's PKCE verifier beside the session.
    this.storage.removeItem(`${this.storageKey}-code-verifier`);
  }

  private static expiring(session: Session): boolean {
    return (
      session.expires_at * TIME.msPerSecond - Date.now() < AUTH.refreshMarginMs
    );
  }

  /** A refresh token works once, so one tab at a time refreshes it. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const locks = globalThis.navigator?.locks;
    if (!locks) return work();
    // The same lock name as supabase-js, so tabs on either version take turns.
    // The lock is held until `work` settles; its promise resolves to `work`'s.
    return locks.request(
      `lock:${this.storageKey}`,
      work,
    ) as Promise<unknown> as Promise<T>;
  }

  /** `stale`: refresh even if not expiring, unless another tab already replaced that token. */
  private async refresh(stale?: string): Promise<Session | null> {
    // Another tab may have refreshed it while this one waited for the lock.
    const current = this.saved();
    if (!current) return null;
    const replaced =
      stale === undefined
        ? !SupabaseAuth.expiring(current)
        : current.refresh_token !== stale;
    if (replaced) return current;
    const response = await this.send(
      `${SUPABASE_ROUTES.token}?grant_type=refresh_token`,
      {
        method: "POST",
        body: { refresh_token: current.refresh_token },
        context: "session",
      },
    );
    if (
      response.status >= HTTP_STATUS.badRequest &&
      response.status < HTTP_STATUS.serverError &&
      response.status !== HTTP_STATUS.tooManyRequests
    ) {
      // Revoked, already used up or its user removed: this session is over.
      if (this.saved()?.refresh_token === current.refresh_token) this.forget();
      return null;
    }
    if (!response.ok) throw SupabaseAuth.failure(response.status);
    const session = SupabaseAuth.parse(await SupabaseAuth.json(response));
    if (!session) throw new CloudError("server", MESSAGES.incompleteResponse);
    this.save(session);
    return session;
  }

  private save(session: Session): void {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(session));
    } catch {
      throw new CloudError("storage", MESSAGES.sessionNotSaved);
    }
  }

  private async send(route: string, request: AuthRequest): Promise<Response> {
    const key = this.config.publicKey;
    const headers: Record<string, string> = { apikey: key };
    const bearer =
      request.token ??
      (key.startsWith(AUTH.publishableKeyPrefix) ? undefined : key);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (request.body) headers["Content-Type"] = "application/json";
    try {
      return await this.http.request(`${this.config.url}${route}`, {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
      });
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (request.context)
        errorReporter.report(
          "signin_network",
          request.context,
          ErrorReporter.networkFailure(error),
        );
      throw new CloudError("network", MESSAGES.unreachable);
    }
  }

  private static async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private static failure(status: number): CloudError {
    if (status === HTTP_STATUS.tooManyRequests)
      return new CloudError("rate_limited", MESSAGES.rateLimited);
    if (status >= HTTP_STATUS.serverError)
      return new CloudError("server", MESSAGES.serverFailed);
    return new CloudError("auth", MESSAGES.guestUnavailable);
  }
}
