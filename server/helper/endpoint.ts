import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import {
  HELPER_ERRORS,
  HELPER_KINDS,
  HELPER_LIMITS,
  type HelperChoice,
  type HelperErrorCode,
  type HelperKind,
  type HelperLocale,
  type HelperPick,
  type HelperRun,
  type HelperSource,
  type HelperTurn,
} from "../../src/shared/helper-contract.ts";
import { HELPER } from "../constants.ts";
import {
  HelperModelError,
  type HelperAnswer,
  type TaskBrief,
} from "./model.ts";

/** Who called, from their Supabase access token. */
export interface HelperUser {
  id: string;
  guest: boolean;
}

/** A run as the database keeps it: what the browser sees, and what a refine needs. */
export interface StoredRun extends HelperRun {
  title: string;
  kind: HelperKind | null;
  context: string[];
  picks: HelperPick[];
  locale: HelperLocale;
  /** The first answer, before any refine. */
  first: string | null;
}

/** What a claim answers: go ahead, or which limit was reached. */
export type Claim = "ok" | "daily_limit";
export type ClaimKind = "start" | "refine" | "call";

export interface HelperStore {
  claim(user: HelperUser, kind: ClaimKind): Promise<Claim>;
  runs(userId: string, taskIds: string[]): Promise<StoredRun[]>;
  save(userId: string, run: StoredRun): Promise<void>;
  remove(userId: string, taskId: string): Promise<void>;
  erase(userId: string): Promise<void>;
}

/** The model calls, behind an interface so tests can stand in for the model. */
export interface HelperBrain {
  classify(
    tasks: { id: string; title: string }[],
  ): Promise<Map<string, HelperKind | null>>;
  choices(brief: TaskBrief): Promise<HelperChoice[]>;
  answer(
    brief: TaskBrief,
    first: string | null,
    turns: HelperTurn[],
  ): Promise<HelperAnswer>;
}

export interface HelperDependencies {
  authenticate(token: string): Promise<HelperUser | null>;
  store: HelperStore;
  brain: HelperBrain;
  /** Keeps the worker alive for work that outlives the response (EdgeRuntime.waitUntil). */
  background(work: Promise<unknown>): void;
  allowedOrigins: Set<string>;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAILURES = {
  generic: "Couldn't finish this one. Try again.",
  refused: "This one isn't something the helper can do.",
} as const;

class RequestError extends Error {
  readonly status: number;
  readonly code: HelperErrorCode;

  constructor(status: number, code: HelperErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = () =>
  new RequestError(
    HTTP_STATUS.badRequest,
    HELPER_ERRORS.badRequest,
    "Some details could not be read.",
  );

/** Reads one request body, refusing anything that is not exactly the contract. */
class HelperInput {
  private readonly body: Record<string, unknown>;

  constructor(body: unknown) {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw bad();
    this.body = body as Record<string, unknown>;
  }

  get action(): string {
    return this.text("action", 20);
  }

  id(name: string): string {
    const value = this.body[name];
    if (typeof value !== "string" || !UUID.test(value)) throw bad();
    return value.toLowerCase();
  }

  text(name: string, max: number, from = this.body): string {
    const value = from[name];
    if (typeof value !== "string") throw bad();
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > max) throw bad();
    return trimmed;
  }

  title(): string {
    return this.text("title", 500);
  }

  kind(): HelperKind {
    const value = this.body.kind;
    if (!(HELPER_KINDS as readonly unknown[]).includes(value)) throw bad();
    return value as HelperKind;
  }

  context(): string[] {
    const value = this.body.context;
    if (!Array.isArray(value) || value.length > HELPER_LIMITS.contextTasks)
      throw bad();
    return value
      .map((title) => {
        if (typeof title !== "string" || title.length > 500) throw bad();
        return title.trim();
      })
      .filter(Boolean);
  }

  locale(): HelperLocale {
    const value = this.body.locale as Record<string, unknown> | undefined;
    if (typeof value !== "object" || value === null) throw bad();
    const timeZone = this.text("timeZone", 64, value);
    const language = this.text("language", 35, value);
    let zone = "UTC";
    try {
      new Intl.DateTimeFormat("en", { timeZone });
      zone = timeZone;
    } catch {
      // An unknown zone is not worth refusing the request over.
    }
    return { timeZone: zone, language };
  }

  picks(): HelperPick[] {
    const value = this.body.picks;
    if (!Array.isArray(value) || value.length > HELPER_LIMITS.questions)
      throw bad();
    return value.map((pick) => {
      if (typeof pick !== "object" || pick === null) throw bad();
      const record = pick as Record<string, unknown>;
      const answer = record.answer;
      if (
        typeof answer !== "string" ||
        answer.length > HELPER_LIMITS.choiceLength
      )
        throw bad();
      return {
        question: this.text("question", HELPER_LIMITS.choiceLength, record),
        answer: answer.trim(),
      };
    });
  }

  ids(name: string, max: number): string[] {
    const value = this.body[name];
    if (!Array.isArray(value) || value.length > max) throw bad();
    return value.map((id) => {
      if (typeof id !== "string" || !UUID.test(id)) throw bad();
      return id.toLowerCase();
    });
  }

  tasks(): { id: string; title: string }[] {
    const value = this.body.tasks;
    if (!Array.isArray(value) || value.length > HELPER_LIMITS.classifyBatch)
      throw bad();
    return value.map((task) => {
      if (typeof task !== "object" || task === null) throw bad();
      const record = task as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "string" || !UUID.test(id)) throw bad();
      return { id: id.toLowerCase(), title: this.text("title", 500, record) };
    });
  }
}

/**
 * The task-helper Edge Function: sorts tasks, asks this-or-that questions,
 * and writes answers in the background while the browser checks back. Every
 * request carries the caller's Supabase access token; runs are theirs only.
 */
export class HelperEndpoint {
  private readonly deps: HelperDependencies;
  private readonly now: () => number;

  constructor(deps: HelperDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** For `Deno.serve`, and safe to pass around. */
  readonly handle = async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      Vary: "Origin",
    });
    if (origin && this.deps.allowedOrigins.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, apikey, content-type",
      );
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: HTTP_STATUS.noContent, headers });
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers });
    try {
      if (request.method !== "POST")
        throw new RequestError(
          HTTP_STATUS.methodNotAllowed,
          HELPER_ERRORS.badRequest,
          "Use POST.",
        );
      const user = await this.caller(request);
      const raw = await request.text();
      if (raw.length > HELPER.maxBodyBytes)
        throw new RequestError(
          HTTP_STATUS.payloadTooLarge,
          HELPER_ERRORS.badRequest,
          "Too much at once.",
        );
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw bad();
      }
      return reply(
        HTTP_STATUS.ok,
        await this.dispatch(user, new HelperInput(body)),
      );
    } catch (error) {
      if (error instanceof RequestError)
        return reply(error.status, {
          code: error.code,
          message: error.message,
        });
      console.error("task-helper failed", error);
      return reply(HTTP_STATUS.serverError, {
        code: HELPER_ERRORS.unavailable,
        message: "The helper is not available right now.",
      });
    }
  };

  private async caller(request: Request): Promise<HelperUser> {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const user = token ? await this.deps.authenticate(token) : null;
    if (!user)
      throw new RequestError(
        HTTP_STATUS.unauthorized,
        HELPER_ERRORS.unauthorized,
        "Open prune again to continue.",
      );
    return user;
  }

  private async dispatch(
    user: HelperUser,
    input: HelperInput,
  ): Promise<unknown> {
    switch (input.action) {
      case "classify": {
        const tasks = input.tasks();
        if (!tasks.length) return { kinds: {} };
        await this.claim(user, "call");
        const kinds = await this.deps.brain.classify(tasks);
        return { kinds: Object.fromEntries(kinds) };
      }
      case "choices": {
        const brief: TaskBrief = {
          title: input.title(),
          kind: null,
          context: input.context(),
          picks: [],
          locale: input.locale(),
        };
        input.id("taskId");
        await this.claim(user, "call");
        try {
          return { choices: await this.deps.brain.choices(brief) };
        } catch (error) {
          // No questions is better than no help: the run can still start.
          if (error instanceof HelperModelError) return { choices: [] };
          throw error;
        }
      }
      case "start":
        return { run: await this.start(user, input) };
      case "get": {
        const runs = await this.deps.store.runs(
          user.id,
          input.ids("taskIds", 200),
        );
        return {
          runs: runs.map((run) => HelperEndpoint.visible(this.fresh(run))),
        };
      }
      case "refine":
        return { run: await this.refine(user, input) };
      case "discard":
        await this.deps.store.remove(user.id, input.id("taskId"));
        return {};
      case "erase":
        await this.deps.store.erase(user.id);
        return {};
      default:
        throw bad();
    }
  }

  private async start(
    user: HelperUser,
    input: HelperInput,
  ): Promise<HelperRun> {
    const taskId = input.id("taskId");
    const run: StoredRun = {
      taskId,
      title: input.title(),
      kind: input.kind(),
      context: input.context(),
      picks: input.picks(),
      locale: input.locale(),
      status: "working",
      answer: null,
      first: null,
      sources: [],
      turns: [],
      error: null,
      updatedAt: this.now(),
    };
    const [existing] = await this.deps.store.runs(user.id, [taskId]);
    if (existing && this.fresh(existing).status === "working")
      throw new RequestError(
        HTTP_STATUS.badRequest,
        HELPER_ERRORS.busy,
        "Already working on it.",
      );
    await this.claim(user, "start");
    await this.deps.store.save(user.id, run);
    this.work(user.id, run);
    return HelperEndpoint.visible(run);
  }

  private async refine(
    user: HelperUser,
    input: HelperInput,
  ): Promise<HelperRun> {
    const taskId = input.id("taskId");
    const message = input.text("message", HELPER_LIMITS.messageLength);
    const locale = input.locale();
    const [found] = await this.deps.store.runs(user.id, [taskId]);
    const existing = found && this.fresh(found);
    if (!existing || existing.answer === null)
      throw new RequestError(
        HTTP_STATUS.notFound,
        HELPER_ERRORS.notFound,
        "Nothing to change yet.",
      );
    if (existing.status === "working")
      throw new RequestError(
        HTTP_STATUS.badRequest,
        HELPER_ERRORS.busy,
        "Already working on it.",
      );
    if (
      existing.turns.filter((turn) => turn.role === "user").length >=
      HELPER_LIMITS.refines
    )
      throw new RequestError(
        HTTP_STATUS.tooManyRequests,
        HELPER_ERRORS.refineLimit,
        "That's as far as this one goes. Discard it to start over.",
      );
    await this.claim(user, "refine");
    // A failed refine leaves its message unanswered: replace it, never stack them.
    const turns =
      existing.turns.at(-1)?.role === "user"
        ? existing.turns.slice(0, -1)
        : existing.turns;
    const run: StoredRun = {
      ...existing,
      locale,
      status: "working",
      error: null,
      turns: [...turns, { role: "user", text: message }],
      updatedAt: this.now(),
    };
    await this.deps.store.save(user.id, run);
    this.work(user.id, run);
    return HelperEndpoint.visible(run);
  }

  /** Writes the answer after the response has gone. */
  private work(userId: string, run: StoredRun): void {
    const brief: TaskBrief = {
      title: run.title,
      kind: run.kind,
      context: run.context,
      picks: run.picks,
      locale: run.locale,
    };
    const job = (async () => {
      let next: StoredRun;
      try {
        const result = await this.deps.brain.answer(
          brief,
          run.first,
          run.turns,
        );
        const refining = run.first !== null;
        next = {
          ...run,
          status: "done",
          answer: result.answer,
          first: run.first ?? result.answer,
          sources: result.sources,
          turns: refining
            ? [...run.turns, { role: "assistant", text: result.answer }]
            : run.turns,
          error: null,
          updatedAt: this.now(),
        };
      } catch (error) {
        if (!(error instanceof HelperModelError))
          console.error("task-helper answer failed", error);
        next = {
          ...run,
          status: "failed",
          error:
            error instanceof HelperModelError && error.message === "refused"
              ? FAILURES.refused
              : FAILURES.generic,
          updatedAt: this.now(),
        };
      }
      await this.deps.store.save(userId, next);
    })().catch((error) => console.error("task-helper could not save", error));
    this.deps.background(job);
  }

  private async claim(user: HelperUser, kind: ClaimKind): Promise<void> {
    const claim = await this.deps.store.claim(user, kind);
    if (claim === "daily_limit")
      throw new RequestError(
        HTTP_STATUS.tooManyRequests,
        HELPER_ERRORS.dailyLimit,
        "That's enough for today. Try again tomorrow.",
      );
  }

  /** A run still working long after its worker could have lived has failed. */
  private fresh(run: StoredRun): StoredRun {
    if (run.status !== "working" || this.now() - run.updatedAt < HELPER.staleMs)
      return run;
    return { ...run, status: "failed", error: FAILURES.generic };
  }

  private static visible(run: StoredRun): HelperRun {
    const sources: HelperSource[] = run.sources;
    return {
      taskId: run.taskId,
      status: run.status,
      answer: run.answer,
      sources,
      turns: run.turns,
      error: run.error,
      updatedAt: run.updatedAt,
    };
  }
}
