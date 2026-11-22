import { batch, createSignal, onMount, type Accessor } from "solid-js";
import { analytics } from "../analytics.ts";
import type { AccountClient } from "../cloud/account.ts";
import { CloudError } from "../cloud/cloud-error.ts";
import { MESSAGES } from "../cloud/messages.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { SHARE, SPACES } from "./constants.ts";
import { browserStorage, TaskStorage } from "./task-storage.ts";
import type { ListState } from "./list-state.ts";
import type { Person } from "./types.ts";
import { SpaceState } from "./space-state.ts";

/** Where the person is in sharing; null when its sheet is closed. */
export type ShareFlow =
  | { step: "loading" }
  /** Sharing and joining both need an account: `joining` when a link brought them. */
  | { step: "sign_in"; joining: boolean; creating?: boolean }
  /** Sharing Personal: name the shared space its tasks move to. */
  | { step: "start" }
  /** The + beside Spaces: name a new, empty space. */
  | { step: "create" }
  /** The link to copy; `joined` right after joining through one. */
  | { step: "link"; joined: boolean }
  /** A link that did not work, or a request that failed: the error says which. */
  | { step: "failed" };

/**
 * Sharing, the way tldraw shares a file: sign in, copy the link, send it.
 * Sharing Personal turns what is in it into a new group space and leaves
 * Personal empty; a group space just gives its link. Whoever opens the link
 * and signs in gets that space beside their own (see planner_list 'share'
 * and 'join'). Create it inside a Solid owner.
 */
export class ShareState {
  readonly flow: Accessor<ShareFlow | null>;
  readonly link: Accessor<string>;
  readonly error: Accessor<string>;
  readonly busy: Accessor<boolean>;
  /** Everyone in the open group space, while its link shows. */
  readonly people: Accessor<Person[]>;

  private readonly client: AccountClient;
  private readonly spaces: SpaceState;
  /** The open space's list, to send what is waiting before sharing it. */
  private readonly list: () => ListState | null;
  private readonly setFlow: (flow: ShareFlow | null) => void;
  private readonly setLink: (link: string) => void;
  private readonly setError: (error: string) => void;
  private readonly setBusy: (busy: boolean) => void;
  private readonly setPeople: (people: Person[]) => void;

  constructor(
    client: AccountClient,
    spaces: SpaceState,
    list: () => ListState | null,
  ) {
    this.client = client;
    this.spaces = spaces;
    this.list = list;
    const [flow, setFlow] = createSignal<ShareFlow | null>(null);
    const [link, setLink] = createSignal("");
    const [error, setError] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const [people, setPeople] = createSignal<Person[]>([]);
    this.people = people;
    this.setPeople = setPeople;
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

  /**
   * Shares Personal: its tasks become a new group space (named `name`), which
   * opens with its link; Personal starts empty.
   */
  async create(name: string): Promise<void> {
    if (this.busy()) return;
    let made: { space: string; token: string } | null = null;
    const ok = await this.request(async () => {
      // Whatever this device has not sent yet goes along.
      await this.list()?.flush();
      made = await this.client.shareSpace(null, name);
    });
    if (!ok || !made) return;
    const { space, token } = made as { space: string; token: string };
    analytics.capture("space_created");
    this.spaces.add({
      id: space,
      kind: "group",
      name: name.trim() || SPACES.groupName,
      people: 1,
      owner: true,
    });
    this.spaces.select(space);
    // Personal's old copy on this device is now the group's.
    new TaskStorage(browserStorage(), null).clear();
    this.showToken(token, false);
  }

  /** The + beside Spaces: a name for a new space, after signing in if needed. */
  async startCreate(): Promise<void> {
    analytics.capture("space_create_opened");
    batch(() => {
      this.setError("");
      this.setFlow({ step: "loading" });
    });
    const account = await this.client.signedIn().catch(() => null);
    this.setFlow(
      account
        ? { step: "create" }
        : { step: "sign_in", joining: false, creating: true },
    );
  }

  /** Makes an empty group space and opens it; Share gives its link. */
  async createSpace(name: string): Promise<void> {
    if (this.busy()) return;
    let space = "";
    const ok = await this.request(async () => {
      space = await this.client.createSpace(name);
    });
    if (!ok) return;
    analytics.capture("space_created", { from: "plus" });
    this.spaces.add({
      id: space,
      kind: "group",
      name: name.trim().slice(0, SPACES.nameLength) || SPACES.groupName,
      people: 1,
      owner: true,
    });
    this.spaces.select(space);
    this.close();
  }

  /**
   * Who is in the open group space. Quiet: the list just stays as it was
   * when this fails (offline), and the count is still shown.
   */
  async loadPeople(): Promise<void> {
    const space = this.spaces.open();
    if (space?.kind !== "group") {
      this.setPeople([]);
      return;
    }
    try {
      const people = await this.client.spacePeople(space.id);
      if (this.spaces.open()?.id !== space.id) return;
      this.setPeople(people.filter(ShareState.isPerson));
    } catch {
      // Shown again the next time the sheet opens.
    }
  }

  private static isPerson(value: unknown): value is Person {
    const person = value as Partial<Person> | null;
    return (
      typeof person === "object" &&
      person !== null &&
      (person.name === null || typeof person.name === "string") &&
      (person.email === null || typeof person.email === "string") &&
      typeof person.owner === "boolean" &&
      typeof person.you === "boolean"
    );
  }

  /** Renames the open group space (from the sheet's name field). */
  async rename(name: string): Promise<void> {
    const space = this.spaces.open();
    if (space?.kind !== "group") return;
    await this.request(() => this.spaces.rename(space.id, name));
  }

  close(): void {
    this.setPeople([]);
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

  /** A member leaves the open group space; its owner deletes it. Both after a confirmation. */
  async leave(): Promise<void> {
    const space = this.spaces.open();
    if (space?.kind !== "group" || this.busy()) return;
    const name = SpaceState.label(space);
    if (
      !window.confirm(
        space.owner
          ? MESSAGES.confirmDeleteSpace(name)
          : MESSAGES.confirmLeaveSpace(name),
      )
    )
      return;
    const ok = await this.request(() => this.spaces.leave(space.id));
    if (!ok) return;
    this.setLink("");
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
    else if (reopen === SHARE.resumeCreate) await this.startCreate();
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
    let space = "";
    const ok = await this.request(async () => {
      space = await this.client.joinSpace(token);
    }, true);
    ShareState.session((storage) => storage.removeItem(STORAGE_KEYS.shareJoin));
    if (!ok) {
      this.setFlow({ step: "failed" });
      return;
    }
    analytics.capture("share_joined");
    if (!this.spaces.spaces().some((item) => item.id === space))
      this.spaces.add({
        id: space,
        kind: "group",
        name: "",
        people: 2,
        owner: false,
      });
    this.spaces.select(space);
    this.showToken(token, true);
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
    // Personal is shared by making a group space of it: ask its name first.
    const current = this.spaces.current();
    if (current === null) {
      this.setFlow({ step: "start" });
      return;
    }
    let token = "";
    const ok = await this.request(async () => {
      token = (await this.client.shareSpace(current)).token;
    });
    if (!ok) {
      this.setFlow({ step: "failed" });
      return;
    }
    this.showToken(token, joined);
  }

  private showToken(token: string, joined: boolean): void {
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
        storage.setItem(
          STORAGE_KEYS.shareResume,
          flow.creating ? SHARE.resumeCreate : SHARE.resumeShare,
        ),
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
