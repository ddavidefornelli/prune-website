import { batch, createSignal, onMount, type Accessor } from "solid-js";
import { analytics } from "../analytics.ts";
import type { AccountClient } from "../cloud/account.ts";
import { CloudError } from "../cloud/cloud-error.ts";
import { MESSAGES } from "../cloud/messages.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { SHARE } from "./constants.ts";
import type { ListState } from "./list-state.ts";

/** Where the person is in sharing; null when its sheet is closed. */
export type ShareFlow =
  | { step: "loading" }
  /** Sharing and joining both need an account: `joining` when a link brought them. */
  | { step: "sign_in"; joining: boolean }
  /** The link to copy; `joined` right after joining through one. */
  | { step: "link"; joined: boolean }
  /** A link that did not work, or a request that failed: the error says which. */
  | { step: "failed" };

/**
 * Sharing the list: sign in, copy the link, send it. Whoever opens the link
 * and signs in joins the same list (see planner_list 'share' and 'join').
 * Create it inside a Solid owner, after the ListState it refreshes.
 */
export class ShareState {
  readonly flow: Accessor<ShareFlow | null>;
  readonly link: Accessor<string>;
  readonly error: Accessor<string>;
  readonly busy: Accessor<boolean>;

  private readonly client: AccountClient;
  private readonly list: ListState;
  private readonly setFlow: (flow: ShareFlow | null) => void;
  private readonly setLink: (link: string) => void;
  private readonly setError: (error: string) => void;
  private readonly setBusy: (busy: boolean) => void;

  constructor(client: AccountClient, list: ListState) {
    this.client = client;
    this.list = list;
    const [flow, setFlow] = createSignal<ShareFlow | null>(null);
    const [link, setLink] = createSignal("");
    const [error, setError] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    this.flow = flow;
    this.setFlow = setFlow;
    this.link = link;
    this.setLink = setLink;
    this.error = error;
    this.setError = setError;
    this.busy = busy;
    this.setBusy = setBusy;
    onMount(() => void this.resume());
  }

  /**
   * Before the app starts: a shared list's link moves its token out of the
   * address bar (so nothing records it) into this tab, until it is joined.
   */
  static takeInvite(): void {
    const params = new URLSearchParams(location.search);
    const token = params.get(SHARE.joinParam);
    if (token === null) return;
    params.delete(SHARE.joinParam);
    const rest = params.toString();
    history.replaceState(
      null,
      "",
      location.pathname + (rest ? `?${rest}` : ""),
    );
    if (!SHARE.tokenPattern.test(token)) return;
    ShareState.session((storage) =>
      storage.setItem(STORAGE_KEYS.shareJoin, token.toLowerCase()),
    );
  }

  /** Opens Share from the menu: the link when signed in, else signing in first. */
  async open(): Promise<void> {
    analytics.capture("share_opened");
    batch(() => {
      this.setError("");
      this.setFlow({ step: "loading" });
    });
    await this.showLink(false);
  }

  close(): void {
    // Closing an invitation turns it down.
    ShareState.session((storage) => storage.removeItem(STORAGE_KEYS.shareJoin));
    batch(() => {
      this.setFlow(null);
      this.setError("");
    });
  }

  /** Copies the link; false when the browser would not (it stays selectable). */
  async copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.link());
      analytics.capture("share_link_copied");
      return true;
    } catch {
      return false;
    }
  }

  /** A member leaves; the owner stops sharing. Both after a confirmation. */
  async leave(): Promise<void> {
    const owner = this.list.sharing()?.role === "owner";
    if (
      this.busy() ||
      !window.confirm(
        owner ? MESSAGES.confirmStopSharing : MESSAGES.confirmLeave,
      )
    )
      return;
    const ok = await this.request(() => this.client.leaveList());
    if (!ok) return;
    analytics.capture(owner ? "share_stopped" : "share_left");
    this.setLink("");
    this.list.refresh();
    this.close();
  }

  async sendCode(email: string): Promise<boolean> {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      this.setError(MESSAGES.emailInvalid);
      return false;
    }
    if (!this.acceptTerms()) return false;
    return this.request(() => this.client.sendCode(address));
  }

  /** Signs in with the emailed code, then reloads as that account and carries on. */
  async verifyCode(email: string, code: string): Promise<void> {
    let signedIn = false;
    const ok = await this.request(async () => {
      signedIn = await this.client.verifyCode(
        email.trim(),
        code.replace(/\D/g, ""),
      );
    });
    if (!ok) return;
    if (!signedIn) {
      this.setError(MESSAGES.codeWrong);
      return;
    }
    analytics.capture("share_signed_in", { method: "email" });
    this.saveResume();
    window.location.reload();
  }

  /** Leaves for Google; the page that comes back finishes signing in and carries on. */
  async google(): Promise<void> {
    if (!this.acceptTerms()) return;
    let url = "";
    const ok = await this.request(async () => {
      url = await this.client.startGoogle(`${window.location.origin}/`);
    });
    if (!ok) return;
    this.saveResume();
    window.location.assign(url);
  }

  /** On arrival: join a link that brought this tab here, or reopen Share after signing in. */
  private async resume(): Promise<void> {
    const token = ShareState.session((storage) =>
      storage.getItem(STORAGE_KEYS.shareJoin),
    );
    const reopen = ShareState.session((storage) => {
      const saved = storage.getItem(STORAGE_KEYS.shareResume);
      storage.removeItem(STORAGE_KEYS.shareResume);
      return saved;
    });
    if (token) await this.join(token);
    else if (reopen) await this.open();
  }

  private async join(token: string): Promise<void> {
    this.setFlow({ step: "loading" });
    let account;
    try {
      account = await this.client.signedIn();
    } catch {
      account = null;
    }
    if (!account) {
      this.setFlow({ step: "sign_in", joining: true });
      return;
    }
    const ok = await this.request(() => this.client.joinList(token), true);
    ShareState.session((storage) => storage.removeItem(STORAGE_KEYS.shareJoin));
    if (!ok) {
      this.setFlow({ step: "failed" });
      return;
    }
    analytics.capture("share_joined");
    this.list.refresh();
    await this.showLink(true);
  }

  private async showLink(joined: boolean): Promise<void> {
    let account;
    try {
      account = await this.client.signedIn();
    } catch {
      account = null;
    }
    if (!account) {
      this.setFlow({ step: "sign_in", joining: false });
      return;
    }
    let token = "";
    const ok = await this.request(async () => {
      token = await this.client.shareToken();
    });
    if (!ok) {
      this.setFlow({ step: "failed" });
      return;
    }
    batch(() => {
      this.setLink(
        `${window.location.origin}/?${SHARE.joinParam}=${encodeURIComponent(token)}`,
      );
      this.setFlow({ step: "link", joined });
    });
  }

  /** Signing in from Share accepts the terms, as adding a first task does. */
  private acceptTerms(): boolean {
    if (this.client.accepted || this.client.accept()) return true;
    this.setError(MESSAGES.privacyNotSaved);
    return false;
  }

  /** A join waits in its own key; Share itself opens again after the reload. */
  private saveResume(): void {
    const flow = this.flow();
    if (flow?.step === "sign_in" && !flow.joining)
      ShareState.session((storage) =>
        storage.setItem(STORAGE_KEYS.shareResume, "1"),
      );
  }

  /**
   * Runs a request, showing why it failed. Only joining shows the server's
   * own words (a dead link, a list that is shared); anything else it refuses
   * (an older backend without sharing, say) reads as "try again".
   */
  private async request(
    work: () => Promise<void>,
    explain = false,
  ): Promise<boolean> {
    batch(() => {
      this.setBusy(true);
      this.setError("");
    });
    try {
      await work();
      return true;
    } catch (error) {
      const code = CloudError.codeOf(error);
      this.setError(
        code === "network"
          ? MESSAGES.unreachable
          : error instanceof CloudError &&
              code !== "server" &&
              (explain || code !== "validation")
            ? error.message
            : MESSAGES.shareUnavailable,
      );
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  /** This tab's sessionStorage, where the browser allows it. */
  private static session<T>(use: (storage: Storage) => T): T | null {
    try {
      return use(window.sessionStorage);
    } catch {
      return null;
    }
  }
}
