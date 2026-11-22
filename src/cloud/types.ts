import type { HelperRequest } from "../shared/helper-contract.ts";
import type { RealtimeAccess } from "./realtime.ts";

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
  /** Calls the task-helper Edge Function as `accountKey`; failures carry its error code. */
  helper<T>(accountKey: string, request: HelperRequest): Promise<T>;
  /** Emails a sign-in code. */
  sendCode(email: string): Promise<void>;
  /** Signs this browser in with an emailed code; false when the code is wrong. */
  verifyCode(email: string, code: string): Promise<boolean>;
  /** Where to send the browser to sign in with Google. */
  startGoogle(redirectTo: string): Promise<string>;
  /** Finishes a Google sign-in this browser started; false when it started none. */
  finishGoogle(code: string): Promise<boolean>;
  /** What a Realtime channel needs for `accountKey`'s session; null without one. */
  realtimeAccess(accountKey: string): Promise<RealtimeAccess | null>;
  /** Forgets this browser's session. */
  signOut(): Promise<void>;
  dispose(): Promise<void>;
}
