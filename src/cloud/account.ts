import type { HelperRequest } from "../shared/helper-contract.ts";
import { BrowserCloud } from "./browser.ts";
import { CloudError } from "./cloud-error.ts";
import { MESSAGES } from "./messages.ts";
import { PrivacyNotice } from "./privacy-state.ts";
import type { RealtimeAccess } from "./realtime.ts";
import type { Account, CloudTransport, Rpc } from "./types.ts";

/** What a list sync sends: whole tasks to save and ids to remove. */
export interface ListChanges {
  save: unknown[];
  remove: string[];
}

type AcceptanceStorage = Pick<Storage, "getItem" | "setItem">;

interface AccountClientOptions {
  cloud?: CloudTransport;
  storage?: AcceptanceStorage | null;
}

/**
 * The account behind this browser's list, created when it is first needed:
 * the saved session, or a new guest. Nothing reaches the cloud before the
 * terms and privacy notice are accepted (by adding a first task).
 */
export class AccountClient {
  private readonly cloud: CloudTransport;
  private readonly storage: AcceptanceStorage | null;
  private readonly timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private account: Account | null = null;
  private disposed = false;

  constructor({ cloud = new BrowserCloud(), storage }: AccountClientOptions) {
    this.cloud = cloud;
    this.storage = storage ?? null;
    // Never keep one account's list on screen once another takes this browser.
    this.cloud.onAccountChange = () => window.location.reload();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cloud.onAccountChange = () => {};
    await this.cloud.dispose();
  }

  get current(): Account | null {
    return this.account;
  }

  /** True once this browser has accepted the current terms and notice. */
  get accepted(): boolean {
    return !!this.storage && new PrivacyNotice(this.storage).isAcknowledged();
  }

  /** Records acceptance; false when the browser cannot store it. */
  accept(): boolean {
    if (!this.storage) return false;
    try {
      new PrivacyNotice(this.storage).require();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The account to sync with. Without a saved session, a guest is made only
   * when `create` is set (there is something to sync); otherwise null.
   */
  async ensureAccount(create = true): Promise<Account | null> {
    this.assertOpen();
    if (this.account) return this.account;
    if (!this.accepted)
      throw new CloudError("privacy", MESSAGES.privacyRequired);
    const account = await this.cloud.identity(create);
    this.assertOpen();
    // A look without `create` that ends after another call made a guest keeps that guest.
    this.account = account ?? this.account;
    return this.account;
  }

  /** Sends changes and reads a space's whole list back; null space is Personal (see planner_list). */
  syncList<T>(changes: ListChanges, space: string | null): Promise<T> {
    return this.call("planner_list", "sync", { ...changes, space });
  }

  /**
   * The signed-in account (with an email), or null for a guest or nobody.
   * Never makes a guest.
   */
  async signedIn(): Promise<Account | null> {
    if (!this.accepted) return null;
    const account = await this.ensureAccount(false);
    return account && !account.guest ? account : null;
  }

  /**
   * Shares a space: Personal becomes a new group space (its tasks move
   * there); a group space gives its link token. See planner_list('share').
   */
  async shareSpace(
    space: string | null,
    name = "",
  ): Promise<{ space: string; token: string }> {
    const result = await this.call<{ space?: unknown; token?: unknown }>(
      "planner_list",
      "share",
      { space, name },
    );
    if (typeof result.space !== "string" || typeof result.token !== "string")
      throw new CloudError("server", MESSAGES.incompleteResponse);
    return { space: result.space, token: result.token };
  }

  /** Joins the group space behind a link token; returns its id. */
  async joinSpace(token: string): Promise<string> {
    const { space } = await this.call<{ space?: unknown }>(
      "planner_list",
      "join",
      { token },
    );
    if (typeof space !== "string")
      throw new CloudError("server", MESSAGES.incompleteResponse);
    return space;
  }

  /** Renames a group space. */
  async renameSpace(space: string, name: string): Promise<void> {
    await this.call("planner_list", "rename", { space, name });
  }

  /** A member leaves a group space; its owner deletes it for everyone. */
  async leaveSpace(space: string): Promise<void> {
    await this.call("planner_list", "leave", { space });
  }

  /** For listening to this account's shared list in real time; null before there is an account. */
  async realtimeAccess(): Promise<RealtimeAccess | null> {
    if (this.disposed || !this.account) return null;
    return this.cloud.realtimeAccess(this.account.accountKey);
  }

  /** Calls the task helper as this browser's account (a guest is made if needed). */
  async helper<T>(request: HelperRequest): Promise<T> {
    const account = await this.ensureAccount(true);
    this.assertOpen();
    return this.cloud.helper<T>(account!.accountKey, request);
  }

  /** Emails a sign-in code. */
  sendCode(email: string): Promise<void> {
    this.requireAccepted();
    return this.cloud.sendCode(email);
  }

  /** Signs this browser in with an emailed code; false when the code is wrong. */
  verifyCode(email: string, code: string): Promise<boolean> {
    this.requireAccepted();
    return this.cloud.verifyCode(email, code);
  }

  /** Where to send the browser to sign in with Google; it comes back to `redirectTo`. */
  startGoogle(redirectTo: string): Promise<string> {
    this.requireAccepted();
    return this.cloud.startGoogle(redirectTo);
  }

  /** Finishes a Google sign-in this browser started; false when there was none. */
  finishGoogle(code: string): Promise<boolean> {
    if (!this.accepted) return Promise.resolve(false);
    return this.cloud.finishGoogle(code);
  }

  /**
   * Erases this browser's account in the cloud: its helper answers, a guest's list, or an older
   * account (marked for removal after its list is erased). Then forgets the
   * session, so the next task starts a new guest.
   */
  async eraseEverything(): Promise<void> {
    if (!this.accepted) return;
    // Never make a guest just to erase it: no session, nothing in the cloud.
    const account = await this.ensureAccount(false);
    if (!account) return;
    await this.cloud.helper(account.accountKey, { action: "erase" });
    await this.call("planner_list", "erase", {});
    if (!account.guest) {
      const result = await this.call<{ isDeleted: boolean }>(
        "planner_call",
        "delete_account",
        {},
      );
      if (result?.isDeleted !== true)
        throw new Error(MESSAGES.deletionUnconfirmed);
    }
    await this.forget();
  }

  /** Forgets this browser's session. */
  async forget(): Promise<void> {
    if (this.accepted) await this.cloud.signOut().catch(() => {});
    this.account = null;
  }

  private requireAccepted(): void {
    this.assertOpen();
    if (!this.accepted)
      throw new CloudError("privacy", MESSAGES.privacyRequired);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(MESSAGES.clientClosed);
  }

  private call<T>(
    rpc: Rpc,
    action: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    this.assertOpen();
    if (!this.account)
      throw new CloudError("privacy", MESSAGES.privacyRequired);
    return this.cloud.call<T>(rpc, this.account.accountKey, {
      action,
      args,
      timezone: this.timezone,
    });
  }
}
