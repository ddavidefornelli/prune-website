import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import { analytics } from "../analytics.ts";
import type { AccountClient } from "../cloud/account.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { SPACES } from "./constants.ts";
import { TaskStorage } from "./task-storage.ts";
import type { Space } from "./types.ts";

/** The switcher's copy in this browser. */
interface SavedSpaces {
  /** The account the spaces belong to. */
  owner: string | null;
  /** The open space: null is Personal. */
  current: string | null;
  spaces: Space[];
}

const isSpace = (value: unknown): value is Space => {
  const space = value as Partial<Space> | null;
  return (
    typeof space?.id === "string" &&
    (space.kind === "personal" || space.kind === "group") &&
    typeof space.name === "string" &&
    typeof space.people === "number" &&
    typeof space.owner === "boolean"
  );
};

/**
 * The spaces this account is in, the way tldraw lists files: Personal
 * (everyone has one) and the group spaces made by sharing Personal or joined
 * through a link. Which one is open survives reloads. Every sync of the open
 * space brings the list up to date. Create it inside a Solid owner.
 */
export class SpaceState {
  /** The open space's id; null is Personal. */
  readonly current: Accessor<string | null>;
  /** Personal first, then group spaces, oldest first. */
  readonly spaces: Accessor<Space[]>;
  /** Group spaces only. */
  readonly groups: Accessor<Space[]>;
  /** The open space, once known (Personal always is). */
  readonly open: Accessor<Space | null>;
  /** Some space has other people in it: worth listening for their changes. */
  readonly live: Accessor<boolean>;

  private readonly client: AccountClient;
  private readonly storage: Storage | null;
  private readonly saved: Accessor<SavedSpaces>;
  private readonly setSaved: (saved: SavedSpaces) => void;

  constructor(client: AccountClient, storage: Storage | null) {
    this.client = client;
    this.storage = storage;
    const [saved, setSaved] = createSignal(this.read());
    this.saved = saved;
    this.setSaved = setSaved;
    this.current = createMemo(() => saved().current);
    this.spaces = createMemo(() => saved().spaces, [], {
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    });
    this.groups = createMemo(() =>
      this.spaces().filter((space) => space.kind === "group"),
    );
    this.open = createMemo(() => {
      const current = this.current();
      return (
        this.spaces().find((space) =>
          current ? space.id === current : space.kind === "personal",
        ) ?? null
      );
    });
    this.live = createMemo(() =>
      this.spaces().some((space) => space.people > 1),
    );
  }

  /** What to call a space on screen. */
  static label(space: Space | null): string {
    if (!space || space.kind === "personal") return SPACES.personalName;
    return space.name || SPACES.groupName;
  }

  /** Opens a space (null: Personal). */
  select(id: string | null): void {
    if (id === this.current()) return;
    this.update({ current: id });
    analytics.capture("space_opened", { personal: id === null });
  }

  /**
   * The account's spaces, from a sync. Another account here starts over:
   * group lists kept for the last one are dropped. A space that is no longer
   * listed closes, back to Personal.
   */
  receive(spaces: Space[]): void {
    const owner = this.client.current?.accountKey ?? null;
    let { current } = this.saved();
    if (owner && this.saved().owner && owner !== this.saved().owner) {
      TaskStorage.clearSpaces(this.storage);
      current = null;
    }
    const known = new Set(spaces.map((space) => space.id));
    for (const space of this.saved().spaces)
      if (space.kind === "group" && !known.has(space.id))
        this.dropList(space.id);
    if (current && !known.has(current)) current = null;
    this.update({ owner, current, spaces });
  }

  /** A space this browser just made or joined, shown before the next sync lists it. */
  add(space: Space): void {
    const spaces = this.saved().spaces.filter((item) => item.id !== space.id);
    this.update({ spaces: [...spaces, space] });
  }

  /** The open space is gone (deleted, or left elsewhere): back to Personal. */
  lost(id: string): void {
    this.dropList(id);
    this.update({
      current: this.current() === id ? null : this.current(),
      spaces: this.saved().spaces.filter((space) => space.id !== id),
    });
  }

  /** A member leaves; the owner deletes the space for everyone. */
  async leave(id: string): Promise<void> {
    const space = this.spaces().find((item) => item.id === id);
    await this.client.leaveSpace(id);
    analytics.capture(space?.owner ? "space_deleted" : "space_left");
    this.lost(id);
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, SPACES.nameLength);
    const space = this.spaces().find((item) => item.id === id);
    if (!clean || !space || space.name === clean) return;
    this.add({ ...space, name: clean });
    await this.client.renameSpace(id, clean);
  }

  private dropList(id: string): void {
    new TaskStorage(this.storage, id).clear();
  }

  private update(change: Partial<SavedSpaces>): void {
    batch(() => {
      const next = { ...this.saved(), ...change };
      this.setSaved(next);
      try {
        this.storage?.setItem(STORAGE_KEYS.spaces, JSON.stringify(next));
      } catch {
        // Kept for this visit; the next sync lists the spaces again.
      }
    });
  }

  private read(): SavedSpaces {
    const empty: SavedSpaces = { owner: null, current: null, spaces: [] };
    try {
      const value = JSON.parse(
        this.storage?.getItem(STORAGE_KEYS.spaces) ?? "null",
      );
      if (typeof value !== "object" || value === null) return empty;
      const spaces = Array.isArray(value.spaces)
        ? value.spaces.filter(isSpace)
        : [];
      const current =
        typeof value.current === "string" &&
        spaces.some((space: Space) => space.id === value.current)
          ? value.current
          : null;
      return {
        owner: typeof value.owner === "string" ? value.owner : null,
        current,
        spaces,
      };
    } catch {
      return empty;
    }
  }
}
