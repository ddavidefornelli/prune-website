/** Records exchanged with the backend. They stay plain JSON objects. */

/**
 * Whose list this browser syncs. Everyone starts as a guest: a Supabase
 * anonymous user, created on first use, with no email. Accounts made before
 * guests (Google or an emailed code) keep working where they are signed in.
 */
export interface Account {
  /** The project and user id: what the device's list belongs to. */
  accountKey: string;
  /** Null for a guest. */
  email: string | null;
  guest: boolean;
}

/** The backend's two RPCs: the list, and deleting an account from before guests. */
export type Rpc = "planner_list" | "planner_call";

export interface RpcRequest {
  action: string;
  args: Record<string, unknown>;
  /** The browser's IANA time zone, for reminder emails. */
  timezone: string;
}

/** The browser's way to the backend: who this browser is, and its RPC calls. */
export interface CloudTransport {
  /** Called once when another account takes over this browser (another tab signed out or in). */
  onAccountChange: () => void;
  /**
   * The saved session's account, checked with the server; without one (or
   * when the server no longer knows it), a new guest when `create` is set.
   * Null otherwise.
   */
  identity(create: boolean): Promise<Account | null>;
  /** Calls `rpc` as `accountKey`, refused if this browser's session is now someone else's. */
  call<T>(rpc: Rpc, accountKey: string, request: RpcRequest): Promise<T>;
  /** Forgets this browser's session. */
  signOut(): Promise<void>;
  dispose(): Promise<void>;
}
