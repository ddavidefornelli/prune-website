import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
  type Setter,
} from "solid-js";
import type { AccountClient } from "../cloud/account.ts";
import type { ListState } from "../tasks/list-state.ts";
import type { Task } from "../tasks/types.ts";
import { CALENDAR } from "./constants.ts";
import type { Busy, PlannedElsewhere } from "./types.ts";
import { Week } from "./week.ts";

/** Where a dragged task would land. */
export type DropTarget =
  | { kind: "slot"; start: number }
  /** Over the calendar, but not on an hour (the week strip, the edges). */
  | { kind: "calendar" }
  | null;

/** A task being dragged, and where it came from. */
export interface Dragging {
  id: string;
  from: "list" | "calendar";
}

/** Finds the drop target under a point; the calendar view provides it. */
export type HitTest = (x: number, y: number) => DropTarget;

/**
 * The calendar above one space's list: which week and day are shown, whether
 * it is open, and the task being dragged onto it. Plans live on the tasks
 * (`startAt`), so they sync with the list. Personal is the person's one
 * calendar, so it also shows what they planned in their groups; a group's
 * calendar shows when its people are busy elsewhere, blurred. Create it
 * inside a Solid owner, like ListState.
 */
export class CalendarState {
  readonly week: Accessor<Week>;
  /** The day shown on phones (0 = Monday). */
  readonly day: Accessor<number>;
  /** Opened with its button: stays open until closed the same way. */
  readonly pinned: Accessor<boolean>;
  readonly dragging: Accessor<Dragging | null>;
  readonly target: Accessor<DropTarget>;
  /** Open: pinned, a task is on its way in, or one just landed. */
  readonly open: Accessor<boolean>;
  /** Laptops show the week; phones a day. */
  readonly wide: Accessor<boolean>;
  /** This week's planned tasks (done ones too). */
  readonly planned: Accessor<Task[]>;
  /** Personal: this week's plans in the person's groups. */
  readonly elsewhere: Accessor<PlannedElsewhere[]>;
  /** A group: this week's busy time of the people in it. */
  readonly busy: Accessor<Busy[]>;

  private readonly list: ListState;
  private readonly setWeek: Setter<Week>;
  private readonly setDay: Setter<number>;
  private readonly setPinned: Setter<boolean>;
  private readonly setDragging: Setter<Dragging | null>;
  private readonly setTarget: Setter<DropTarget>;
  private readonly setLanded: Setter<boolean>;
  private readonly client: AccountClient;
  private readonly setElsewhere: Setter<PlannedElsewhere[]>;
  private readonly setBusy: Setter<Busy[]>;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private loadDue = 0;
  private loads = 0;
  private hitTest: HitTest = () => null;
  private landedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(list: ListState, client: AccountClient) {
    this.list = list;
    this.client = client;
    // A refresh that changes nothing leaves the calendar as it is.
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const [elsewhere, setElsewhere] = createSignal<PlannedElsewhere[]>([], {
      equals: same,
    });
    const [busy, setBusy] = createSignal<Busy[]>([], { equals: same });
    this.elsewhere = elsewhere;
    this.busy = busy;
    this.setElsewhere = setElsewhere;
    this.setBusy = setBusy;
    const now = Date.now();
    const [week, setWeek] = createSignal(Week.of(now), {
      equals: (a, b) => a.start === b.start,
    });
    const [day, setDay] = createSignal(Math.max(0, Week.of(now).dayOf(now)));
    const [pinned, setPinned] = createSignal(false);
    const [dragging, setDragging] = createSignal<Dragging | null>(null);
    const [target, setTarget] = createSignal<DropTarget>(null, {
      equals: (a, b) =>
        a === b ||
        (a?.kind === b?.kind &&
          (a?.kind !== "slot" || a.start === (b as { start: number }).start)),
    });
    const [landed, setLanded] = createSignal(false);
    this.week = week;
    this.day = day;
    this.pinned = pinned;
    this.dragging = dragging;
    this.target = target;
    this.setWeek = setWeek;
    this.setDay = setDay;
    this.setPinned = setPinned;
    this.setDragging = setDragging;
    this.setTarget = setTarget;
    this.setLanded = setLanded;
    this.open = createMemo(() => pinned() || !!dragging() || landed());

    const media = window.matchMedia(CALENDAR.wideQuery);
    const [wide, setWide] = createSignal(media.matches);
    const changed = () => setWide(media.matches);
    media.addEventListener("change", changed);
    this.wide = wide;

    this.planned = createMemo(() => {
      const shown = week();
      return list
        .list()
        .tasks.filter(
          (task) =>
            task.startAt !== null &&
            task.startAt >= shown.start &&
            task.startAt < shown.end,
        );
    });

    // Other spaces' plans: for each week shown, soon after this list
    // changes, every few minutes while in sight, and on coming back.
    createEffect(
      on([week, () => !!list.account()], ([, account]) => {
        if (account) this.load(0);
      }),
    );
    createEffect(
      on(
        () => list.list(),
        () => this.load(CALENDAR.reloadAfterChangeMs),
        { defer: true },
      ),
    );
    const visible = () => {
      if (document.visibilityState === "visible") this.load(0);
    };
    const poll = setInterval(visible, CALENDAR.reloadMs);
    document.addEventListener("visibilitychange", visible);

    onCleanup(() => {
      media.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(poll);
      clearTimeout(this.landedTimer);
      clearTimeout(this.loadTimer);
    });
  }

  /**
   * Asks the cloud for other spaces' plans in the week shown, after `delay`;
   * a load already due sooner is never pushed back.
   */
  private load(delay: number): void {
    const due = Date.now() + delay;
    if (this.loadTimer !== undefined && this.loadDue <= due) return;
    clearTimeout(this.loadTimer);
    this.loadDue = due;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      void this.fetch();
    }, delay);
  }

  private async fetch(): Promise<void> {
    const account = untrack(this.list.account);
    // A guest is in no group: there is nothing elsewhere to show.
    if (!account || account.guest) return;
    const week = untrack(this.week);
    const ticket = ++this.loads;
    let answer: unknown;
    try {
      answer = await this.client.spaceCalendar(
        this.list.space,
        week.start,
        week.end,
      );
    } catch {
      return; // Quiet: the calendar still has its own tasks; the next load tries again.
    }
    // A later load (or another week) already answered.
    if (ticket !== this.loads || untrack(this.week).start !== week.start)
      return;
    const body = (answer ?? {}) as { elsewhere?: unknown; busy?: unknown };
    batch(() => {
      this.setElsewhere(CalendarState.readElsewhere(body.elsewhere));
      this.setBusy(CalendarState.readBusy(body.busy));
    });
  }

  private static readElsewhere(value: unknown): PlannedElsewhere[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (task): task is PlannedElsewhere =>
        typeof task?.id === "string" &&
        typeof task.space === "string" &&
        typeof task.spaceName === "string" &&
        typeof task.title === "string" &&
        Number.isFinite(task.startAt) &&
        Number.isInteger(task.minutes) &&
        typeof task.done === "boolean" &&
        typeof task.notes === "string",
    );
  }

  private static readBusy(value: unknown): Busy[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (span): span is Busy =>
        Number.isFinite(span?.start) &&
        Number.isFinite(span.end) &&
        span.end > span.start,
    );
  }

  /** What the calendar looks like on screen; set by the view. */
  setHitTest(test: HitTest): void {
    this.hitTest = test;
  }

  toggle(): void {
    this.setPinned((open) => !open);
  }

  showWeek(weeks: number): void {
    this.setWeek((week) => week.shift(weeks));
  }

  showToday(): void {
    const now = Date.now();
    batch(() => {
      this.setWeek(Week.of(now));
      this.setDay(Week.of(now).dayOf(now));
    });
  }

  showDay(day: number): void {
    this.setDay(day);
  }

  /** A task was picked up: the calendar opens to take it. */
  beginDrag(id: string, from: Dragging["from"]): void {
    clearTimeout(this.landedTimer);
    batch(() => {
      this.setLanded(false);
      this.setTarget(null);
      this.setDragging({ id, from });
    });
  }

  /** The task moved to (x, y): where it would land. */
  moveDrag(x: number, y: number): DropTarget {
    const target = this.hitTest(x, y);
    this.setTarget(target);
    return target;
  }

  /**
   * The task was let go. On an hour, it is planned there; dragged out of the
   * calendar, it leaves it. The calendar closes again a moment later, unless
   * it was opened with its button.
   */
  endDrag(cancelled = false): void {
    const drag = this.dragging();
    const target = this.target();
    let landed = false;
    if (drag && !cancelled) {
      if (target?.kind === "slot") {
        this.list.schedule(drag.id, target.start);
        landed = true;
      } else if (!target && drag.from === "calendar")
        this.list.schedule(drag.id, null);
    }
    batch(() => {
      this.setDragging(null);
      this.setTarget(null);
      this.setLanded(landed);
    });
    if (landed)
      this.landedTimer = setTimeout(
        () => this.setLanded(false),
        CALENDAR.landedMs,
      );
  }
}
