import {
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  type Accessor,
  type Setter,
} from "solid-js";
import { analytics } from "../analytics.ts";
import type { AccountClient } from "../cloud/account.ts";
import { CloudError } from "../cloud/cloud-error.ts";
import { MESSAGES } from "../cloud/messages.ts";
import {
  HELPER_ERRORS,
  HELPER_KINDS,
  HELPER_LIMITS,
  type HelperChoice,
  type HelperKind,
  type HelperLocale,
  type HelperPick,
  type HelperRun,
} from "../shared/helper-contract.ts";
import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { HELPER_TIMING } from "./constants.ts";
import type { ListState } from "./list-state.ts";

/** What the helper decided about one task, for the title it had then. */
interface SavedKind {
  title: string;
  kind: HelperKind | null;
}

/** The helper's part of this browser's storage. */
interface SavedHelper {
  /** The account the runs belong to. */
  owner: string | null;
  kinds: Record<string, SavedKind>;
  runs: Record<string, HelperRun>;
}

/** A "Do it for me" that waits for sign-in (and its page reload) to finish. */
interface Resume {
  taskId: string;
  picks: HelperPick[];
}

/** Where the person is in "Do it for me"; null when its sheet is closed. */
export type HelperFlow =
  | { step: "asking"; taskId: string }
  | {
      step: "choose";
      taskId: string;
      choices: HelperChoice[];
      picks: HelperPick[];
    }
  | { step: "sign_in"; taskId: string; picks: HelperPick[] }
  | { step: "answer"; taskId: string };

type Timer = ReturnType<typeof setTimeout>;

const isRun = (value: unknown): value is HelperRun => {
  const run = value as Partial<HelperRun> | null;
  return (
    typeof run === "object" &&
    run !== null &&
    typeof run.taskId === "string" &&
    (run.status === "working" ||
      run.status === "done" ||
      run.status === "failed") &&
    (run.answer === null || typeof run.answer === "string") &&
    Array.isArray(run.sources) &&
    Array.isArray(run.turns) &&
    typeof run.updatedAt === "number"
  );
};

/**
 * "Do it for me": which tasks the helper can do (decided quietly as tasks are
 * added), the this-or-that questions, the answers it writes in the
 * background, and signing in once a guest's free answers are used. Create it
 * inside a Solid owner, after the ListState it reads.
 */
export class HelperState {
  readonly flow: Accessor<HelperFlow | null>;
  /** One line for the open sheet: why the last step did not work. */
  readonly error: Accessor<string>;
  /** A request from the sheet is on its way. */
  readonly busy: Accessor<boolean>;

  private readonly client: AccountClient;
  private readonly list: ListState;
  private readonly storage: Storage | null;
  private readonly saved: Accessor<SavedHelper>;
  private readonly setSaved: Setter<SavedHelper>;
  private readonly setFlow: Setter<HelperFlow | null>;
  private readonly setError: Setter<string>;
  private readonly setBusy: Setter<boolean>;
  private classifying = false;
  private classifyTimer: Timer | undefined;
  private classifyAfter = 0;
  private pollTimer: Timer | undefined;
  private disposed = false;

  constructor(
    client: AccountClient,
    list: ListState,
    storage: Storage | null = HelperState.localStorage(),
  ) {
    this.client = client;
    this.list = list;
    this.storage = storage;
    const [saved, setSaved] = createSignal(this.read());
    const [flow, setFlow] = createSignal<HelperFlow | null>(null);
    const [error, setError] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    this.saved = saved;
    this.setSaved = setSaved;
    this.flow = flow;
    this.setFlow = setFlow;
    this.error = error;
    this.setError = setError;
    this.busy = busy;
    this.setBusy = setBusy;

    // New and renamed tasks are sorted in a quiet batch.
    createEffect(on(list.open, () => this.scheduleClassify()));
    // Answers being written are checked on until they are done.
    createEffect(
      on(
        () => this.workingIds().join(),
        (ids) => {
          clearTimeout(this.pollTimer);
          if (ids)
            this.pollTimer = setTimeout(
              () => void this.poll(),
              HELPER_TIMING.pollMs,
            );
        },
      ),
    );
    // Runs belong to an account: another account here starts with none.
    createEffect(
      on(list.account, (account) => {
        if (!account) return;
        if (this.saved().owner !== account.accountKey)
          this.update({ owner: account.accountKey, runs: {} });
        void this.refresh();
        this.resume();
      }),
    );
    onCleanup(() => {
      this.disposed = true;
      clearTimeout(this.classifyTimer);
      clearTimeout(this.pollTimer);
    });
  }

  /** What the helper can make of a task, or null: no "Do it for me" for it. */
  kind(taskId: string): HelperKind | null {
    const task = this.list.task(taskId);
    const saved = this.saved().kinds[taskId];
    if (!task || task.done || !saved || saved.title !== task.title) return null;
    return saved.kind;
  }

  run(taskId: string): HelperRun | undefined {
    return this.saved().runs[taskId];
  }

  /** "Do it for me": a few questions first, unless the task is already clear. */
  async open(taskId: string): Promise<void> {
    const task = this.list.task(taskId);
    if (!task || this.busy()) return;
    analytics.capture("helper_opened");
    batch(() => {
      this.setError("");
      this.setFlow({ step: "asking", taskId });
    });
    let choices: HelperChoice[] = [];
    try {
      const answer = await this.client.helper<{ choices?: unknown }>({
        action: "choices",
        taskId,
        title: task.title,
        context: this.context(taskId),
        locale: HelperState.locale(),
      });
      choices = HelperState.choices(answer.choices);
    } catch (error) {
      if (CloudError.codeOf(error) === HELPER_ERRORS.dailyLimit) {
        this.fail(error);
        return;
      }
      // Without questions the helper still does the task.
    }
    if (this.flow()?.taskId !== taskId) return;
    if (!choices.length) {
      await this.start(taskId, []);
      return;
    }
    this.setFlow({ step: "choose", taskId, choices, picks: [] });
  }

  /** One answer to the current question; an empty one means either is fine. */
  async pick(answer: string): Promise<void> {
    const flow = this.flow();
    if (flow?.step !== "choose" || this.busy()) return;
    const question = flow.choices[flow.picks.length];
    if (!question) return;
    const picks = [
      ...flow.picks,
      {
        question: question.question,
        answer: answer.trim().slice(0, HELPER_LIMITS.choiceLength),
      },
    ];
    if (picks.length < flow.choices.length) {
      this.setFlow({ ...flow, picks });
      return;
    }
    await this.start(flow.taskId, picks);
  }

  /** Opens a finished (or failed) answer. */
  show(taskId: string): void {
    if (!this.run(taskId)) return;
    batch(() => {
      this.setError("");
      this.setFlow({ step: "answer", taskId });
    });
  }

  close(): void {
    batch(() => {
      this.setFlow(null);
      this.setError("");
    });
  }

  /** Tries a failed answer again, with the same choices. */
  async retry(taskId: string): Promise<void> {
    await this.start(taskId, []);
  }

  /** Asks for a change to the open answer. */
  async refine(message: string): Promise<boolean> {
    const flow = this.flow();
    const text = message.trim();
    if (flow?.step !== "answer" || !text || this.busy()) return false;
    return this.request(async () => {
      const answer = await this.client.helper<{ run?: unknown }>({
        action: "refine",
        taskId: flow.taskId,
        message: text.slice(0, HELPER_LIMITS.messageLength),
        locale: HelperState.locale(),
      });
      this.store(answer.run);
      analytics.capture("helper_refined");
    });
  }

  /** Throws the open answer away. */
  async discard(): Promise<void> {
    const flow = this.flow();
    if (flow?.step !== "answer" || this.busy()) return;
    const ok = await this.request(async () => {
      await this.client.helper({ action: "discard", taskId: flow.taskId });
    });
    if (!ok) return;
    const runs = { ...this.saved().runs };
    delete runs[flow.taskId];
    this.update({ runs });
    analytics.capture("helper_discarded");
    this.close();
  }

  async sendCode(email: string): Promise<boolean> {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      this.setError(MESSAGES.emailInvalid);
      return false;
    }
    return this.request(() => this.client.sendCode(address));
  }

  /** Signs in with the emailed code, then reloads as that account and carries on. */
  async verifyCode(email: string, code: string): Promise<void> {
    const digits = code.replace(/\D/g, "");
    let signedIn = false;
    const ok = await this.request(async () => {
      signedIn = await this.client.verifyCode(email.trim(), digits);
    });
    if (!ok) return;
    if (!signedIn) {
      this.setError(MESSAGES.codeWrong);
      return;
    }
    analytics.capture("helper_signed_in", { method: "email" });
    this.saveResume();
    window.location.reload();
  }

  /** Leaves for Google; the page that comes back finishes signing in and carries on. */
  async google(): Promise<void> {
    let url = "";
    const ok = await this.request(async () => {
      url = await this.client.startGoogle(`${window.location.origin}/`);
    });
    if (!ok) return;
    this.saveResume();
    window.location.assign(url);
  }

  private async start(taskId: string, picks: HelperPick[]): Promise<void> {
    const task = this.list.task(taskId);
    const kind = this.kind(taskId) ?? this.saved().kinds[taskId]?.kind;
    if (!task || !kind) {
      this.close();
      return;
    }
    let refused: unknown = null;
    const ok = await this.request(async () => {
      try {
        const answer = await this.client.helper<{ run?: unknown }>({
          action: "start",
          taskId,
          title: task.title,
          kind,
          context: this.context(taskId),
          picks,
          locale: HelperState.locale(),
        });
        this.store(answer.run);
      } catch (error) {
        if (CloudError.codeOf(error) !== HELPER_ERRORS.signIn) throw error;
        refused = error;
      }
    });
    if (refused) {
      analytics.capture("helper_sign_in_asked");
      this.setFlow({ step: "sign_in", taskId, picks });
      return;
    }
    if (!ok) {
      // Asked straight from the row (a retry): show why in the answer sheet.
      if (!this.flow()) this.setFlow({ step: "answer", taskId });
      return;
    }
    analytics.capture("helper_started", { kind });
    this.close();
  }

  /** Runs one request from the sheet; false (with the reason shown) when it failed. */
  private async request(work: () => Promise<void>): Promise<boolean> {
    batch(() => {
      this.setBusy(true);
      this.setError("");
    });
    try {
      await work();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  private fail(error: unknown): void {
    const message =
      error instanceof CloudError && error.code !== "server"
        ? error.message
        : MESSAGES.helperUnavailable;
    this.setError(
      CloudError.codeOf(error) === "network" ? MESSAGES.unreachable : message,
    );
  }

  private workingIds(): string[] {
    return Object.values(this.saved().runs)
      .filter((run) => run.status === "working")
      .map((run) => run.taskId)
      .sort();
  }

  private async poll(): Promise<void> {
    const ids = this.workingIds();
    if (!ids.length || this.disposed) return;
    await this.fetchRuns(ids);
    // Still working, or the check failed: look again in a while.
    if (!this.disposed && this.workingIds().length) {
      clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(() => void this.poll(), HELPER_TIMING.pollMs);
    }
  }

  /** Brings every saved answer up to date, dropping those for deleted tasks. */
  private async refresh(): Promise<void> {
    const runs = this.saved().runs;
    const kept = Object.fromEntries(
      Object.entries(runs).filter(([id]) => this.list.task(id)),
    );
    if (Object.keys(kept).length !== Object.keys(runs).length)
      this.update({ runs: kept });
    const ids = Object.keys(kept);
    if (ids.length) await this.fetchRuns(ids);
  }

  private async fetchRuns(ids: string[]): Promise<void> {
    try {
      const answer = await this.client.helper<{ runs?: unknown }>({
        action: "get",
        taskIds: ids,
      });
      if (!Array.isArray(answer.runs)) return;
      const found = new Map(
        answer.runs.filter(isRun).map((run) => [run.taskId, run]),
      );
      const runs = { ...this.saved().runs };
      for (const id of ids) {
        const run = found.get(id);
        if (run) runs[id] = run;
        // Gone on the server (discarded on another device).
        else delete runs[id];
      }
      this.update({ runs });
    } catch {
      // Checked again on the next poll or visit.
    }
  }

  private store(value: unknown): void {
    if (!isRun(value))
      throw new CloudError("server", MESSAGES.helperUnavailable);
    this.update({ runs: { ...this.saved().runs, [value.taskId]: value } });
  }

  private scheduleClassify(): void {
    clearTimeout(this.classifyTimer);
    if (this.disposed || !this.client.accepted) return;
    const wait = Math.max(
      HELPER_TIMING.classifyDebounceMs,
      this.classifyAfter - Date.now(),
    );
    this.classifyTimer = setTimeout(() => void this.classify(), wait);
  }

  private async classify(): Promise<void> {
    if (this.classifying || this.disposed) return;
    const kinds = this.saved().kinds;
    const todo = this.list
      .open()
      .filter((task) => !task.done && kinds[task.id]?.title !== task.title)
      .slice(0, HELPER_LIMITS.classifyBatch);
    if (!todo.length) return;
    this.classifying = true;
    try {
      const answer = await this.client.helper<{
        kinds?: Record<string, unknown>;
      }>({
        action: "classify",
        tasks: todo.map((task) => ({ id: task.id, title: task.title })),
      });
      const next = { ...this.saved().kinds };
      for (const task of todo) {
        const kind = answer.kinds?.[task.id];
        next[task.id] = {
          title: task.title,
          kind: (HELPER_KINDS as readonly unknown[]).includes(kind)
            ? (kind as HelperKind)
            : null,
        };
      }
      // Forget tasks that are gone, so storage never grows without end.
      for (const id of Object.keys(next))
        if (!this.list.task(id)) delete next[id];
      this.update({ kinds: next });
      this.classifyAfter = 0;
    } catch {
      this.classifyAfter = Date.now() + HELPER_TIMING.classifyRetryMs;
    } finally {
      this.classifying = false;
    }
    // More than one batch waiting, or tasks added meanwhile.
    this.scheduleClassify();
  }

  private context(taskId: string): string[] {
    return this.list
      .open()
      .filter((task) => task.id !== taskId && !task.done)
      .slice(0, HELPER_LIMITS.contextTasks)
      .map((task) => task.title);
  }

  private saveResume(): void {
    const flow = this.flow();
    if (flow?.step !== "sign_in") return;
    const resume: Resume = { taskId: flow.taskId, picks: flow.picks };
    try {
      sessionStorage.setItem(STORAGE_KEYS.helperResume, JSON.stringify(resume));
    } catch {
      // Without it, the person taps "Do it for me" once more after signing in.
    }
  }

  /** After signing in: carry on with the "Do it for me" that asked for it. */
  private resume(): void {
    let resume: Resume | null;
    try {
      resume = JSON.parse(
        sessionStorage.getItem(STORAGE_KEYS.helperResume) ?? "null",
      );
      sessionStorage.removeItem(STORAGE_KEYS.helperResume);
    } catch {
      return;
    }
    if (
      !resume ||
      typeof resume.taskId !== "string" ||
      !Array.isArray(resume.picks)
    )
      return;
    if (!this.list.task(resume.taskId)) return;
    this.setFlow({ step: "asking", taskId: resume.taskId });
    void this.start(resume.taskId, resume.picks);
  }

  private update(change: Partial<SavedHelper>): void {
    const next = { ...this.saved(), ...change };
    this.setSaved(next);
    try {
      this.storage?.setItem(STORAGE_KEYS.helper, JSON.stringify(next));
    } catch {
      // Kept on screen for this visit; the server still has the answers.
    }
  }

  private read(): SavedHelper {
    const empty: SavedHelper = { owner: null, kinds: {}, runs: {} };
    try {
      const value = JSON.parse(
        this.storage?.getItem(STORAGE_KEYS.helper) ?? "null",
      );
      if (typeof value !== "object" || value === null) return empty;
      const runs: Record<string, HelperRun> = {};
      for (const run of Object.values(value.runs ?? {}))
        if (isRun(run)) runs[run.taskId] = run;
      const kinds: Record<string, SavedKind> = {};
      for (const [id, saved] of Object.entries(value.kinds ?? {})) {
        const entry = saved as Partial<SavedKind>;
        if (typeof entry?.title === "string")
          kinds[id] = {
            title: entry.title,
            kind: (HELPER_KINDS as readonly unknown[]).includes(entry.kind)
              ? (entry.kind as HelperKind)
              : null,
          };
      }
      return {
        owner: typeof value.owner === "string" ? value.owner : null,
        kinds,
        runs,
      };
    } catch {
      return empty;
    }
  }

  private static choices(value: unknown): HelperChoice[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is HelperChoice =>
          typeof item?.question === "string" &&
          Array.isArray(item.options) &&
          item.options.length === 2 &&
          item.options.every((option: unknown) => typeof option === "string"),
      )
      .slice(0, HELPER_LIMITS.questions);
  }

  static locale(): HelperLocale {
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      language: navigator.language || "en",
    };
  }

  private static localStorage(): Storage | null {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
}
