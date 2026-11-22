import {
  HELPER_KINDS,
  HELPER_LIMITS,
  type HelperChoice,
  type HelperKind,
  type HelperLocale,
  type HelperPick,
  type HelperSource,
  type HelperTurn,
} from "../../src/shared/helper-contract.ts";
import { HELPER } from "../constants.ts";

/** What the helper knows about one task when it works on it. */
export interface TaskBrief {
  title: string;
  kind: HelperKind | null;
  /** The person's other open tasks, for context. */
  context: string[];
  picks: HelperPick[];
  locale: HelperLocale;
}

export interface HelperAnswer {
  answer: string;
  sources: HelperSource[];
}

/** The model refused, or stopped without an answer. */
export class HelperModelError extends Error {}

/** Where the model runs: any API that speaks OpenAI's chat completions format. */
export interface ModelConfig {
  /** The full chat completions URL, e.g. https://openrouter.ai/api/v1/chat/completions. */
  url: string;
  apiKey: string;
  /** The model's name at that host, e.g. deepseek/deepseek-v4.1-flash. */
  model: string;
  /** Sent with every request: OpenRouter's provider routing (which hosts may serve it). */
  extra?: Record<string, unknown>;
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  json: boolean;
}

const CLASSIFY_SYSTEM = `You sort a person's to-do items. For each item, decide whether an assistant that can only write text (it cannot browse the web or act in the world) could do the useful part of it right now, and what it would make:
- "draft": a message, email, post, letter, bio or other text to write.
- "list": ideas, options, a shopping or packing list, a checklist.
- "plan": steps, a schedule, an itinerary, a routine.
- "research": explaining, comparing or summarising something from general knowledge.
- "none": anything else: physical errands (buy milk, clean the kitchen), things only the person can do (call mom, pay the bill, go to the gym), things that need live information (today's prices, opening hours, availability), private information the assistant cannot see, or items too vague to act on.
Prefer "none" when unsure. An item asking to send or book something still counts when the assistant could prepare it (write the email, plan the options).
Answer with JSON only: {"items": [{"id": "<the item's id>", "kind": "draft" | "list" | "plan" | "research" | "none"}]}, one entry per item.`;

const CHOICES_SYSTEM = `Before an assistant does a task from a person's to-do list, it may ask up to ${HELPER_LIMITS.questions} quick this-or-that questions. Each has exactly two short options the person taps.
Ask only what would clearly change the result and cannot be guessed from the task, the other tasks, the date, the time zone or the language: tone (warm or formal), length (short or detailed), style or look (minimal or bold), budget (cheap or premium), format (bullet list or paragraphs), and so on. When a fact matters (a city, a date), offer the two most likely answers; the person can also type their own.
Ask nothing when the task is already clear. Questions and options are short (options at most four words), written in the language of the task.
Answer with JSON only: {"questions": [{"question": "...", "options": ["...", "..."]}]}, or {"questions": []}.`;

const ANSWER_SYSTEM = `You do tasks from a person's to-do list and hand back the finished result, ready to use.
- Write the thing itself: the email, the list, the plan, the explanation. No preamble, no "Here is", no closing offer of more help.
- Plain text only: short paragraphs, "- " for list items, "1. " for steps. No headings, bold, tables or code blocks.
- You cannot browse the web. Never invent specifics you cannot know (prices, opening hours, addresses, phone numbers, availability, recent news): say briefly what to check and where (for example "check the opening hours on the clinic's site").
- You cannot act in the world: never say you sent, booked, bought or called anything. When the task needs that, prepare it so the person can do it in a minute.
- Follow the person's choices. Use the date, time zone and language you are given; write in the language of the task.
- Keep it as short as the task allows.`;

const KIND_DESCRIPTIONS: Record<HelperKind, string> = {
  draft: "a text to write",
  list: "a list",
  plan: "a plan",
  research: "an explanation or comparison",
};

/**
 * The helper's three model calls: which tasks it can do, what to ask first,
 * and the answer itself. Any host with OpenAI's chat completions format
 * works; which one is a deployment setting (see the task-helper function).
 */
export class HelperModel {
  private readonly config: ModelConfig;
  private readonly fetch: typeof fetch;

  constructor(config: ModelConfig) {
    this.config = config;
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The kind of help each task can get, null where it can get none. */
  async classify(
    tasks: { id: string; title: string }[],
  ): Promise<Map<string, HelperKind | null>> {
    const result = new Map<string, HelperKind | null>();
    if (!tasks.length) return result;
    const parsed = (await this.json({
      system: CLASSIFY_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            items: tasks.map((task) => ({ id: task.id, item: task.title })),
          }),
        },
      ],
      maxTokens: HELPER.classifyTokens,
      timeoutMs: HELPER.quickTimeoutMs,
      json: true,
    })) as { items?: { id?: unknown; kind?: unknown }[] };
    const known = new Set(tasks.map((task) => task.id));
    for (const task of tasks) result.set(task.id, null);
    for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
      if (typeof item?.id !== "string" || !known.has(item.id)) continue;
      result.set(
        item.id,
        (HELPER_KINDS as readonly unknown[]).includes(item.kind)
          ? (item.kind as HelperKind)
          : null,
      );
    }
    return result;
  }

  /** Up to three this-or-that questions; none when the task is clear. */
  async choices(brief: TaskBrief): Promise<HelperChoice[]> {
    const parsed = (await this.json({
      system: CHOICES_SYSTEM,
      messages: [{ role: "user", content: HelperModel.describe(brief) }],
      maxTokens: HELPER.choicesTokens,
      timeoutMs: HELPER.quickTimeoutMs,
      json: true,
    })) as { questions?: { question?: unknown; options?: unknown }[] };
    const clip = (value: string) =>
      value.trim().slice(0, HELPER_LIMITS.choiceLength);
    return (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter(
        (item): item is { question: string; options: string[] } =>
          typeof item?.question === "string" &&
          !!item.question.trim() &&
          Array.isArray(item.options) &&
          item.options.length >= 2 &&
          item.options
            .slice(0, 2)
            .every((option) => typeof option === "string" && !!option.trim()),
      )
      .slice(0, HELPER_LIMITS.questions)
      .map((item) => ({
        question: clip(item.question),
        options: [clip(item.options[0]), clip(item.options[1])],
      }));
  }

  /**
   * The finished answer. `turns` are the refine conversation so far; the
   * last one is the person's newest message.
   */
  async answer(
    brief: TaskBrief,
    first: string | null,
    turns: HelperTurn[],
  ): Promise<HelperAnswer> {
    const messages: ChatMessage[] = [
      { role: "user", content: HelperModel.describe(brief) },
    ];
    if (first !== null) messages.push({ role: "assistant", content: first });
    for (const turn of turns)
      messages.push({ role: turn.role, content: turn.text });
    const text = (
      await this.chat({
        system: ANSWER_SYSTEM,
        messages,
        maxTokens: HELPER.answerTokens,
        timeoutMs: HELPER.answerTimeoutMs,
        json: false,
      })
    ).trim();
    if (!text) throw new HelperModelError("empty");
    return { answer: text.slice(0, HELPER_LIMITS.answerLength), sources: [] };
  }

  private async json(request: ChatRequest): Promise<unknown> {
    const text = await this.chat(request);
    // Some hosts wrap JSON in a code fence even when asked not to.
    const body = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
    try {
      return JSON.parse(body);
    } catch {
      throw new HelperModelError("unreadable");
    }
  }

  /** One chat completion; the text it answered with. */
  private async chat(request: ChatRequest): Promise<string> {
    const response = await this.fetch(this.config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...this.config.extra,
        model: this.config.model,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          ...request.messages,
        ],
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Model request failed with status ${response.status}`);
    const body = (await response.json()) as {
      choices?: { finish_reason?: string; message?: { content?: unknown } }[];
    };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "content_filter")
      throw new HelperModelError("refused");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new HelperModelError("empty");
    return content;
  }

  /** The task as the model reads it. */
  private static describe(brief: TaskBrief): string {
    const now = new Date();
    let date: string;
    try {
      date = now.toLocaleString("en-GB", {
        timeZone: brief.locale.timeZone,
        dateStyle: "full",
        timeStyle: "short",
      });
    } catch {
      date = now.toUTCString();
    }
    const lines = [
      `Task: ${brief.title}`,
      brief.kind ? `What to make: ${KIND_DESCRIPTIONS[brief.kind]}` : "",
      `Now: ${date} (${brief.locale.timeZone})`,
      `Browser language: ${brief.locale.language}`,
    ].filter(Boolean);
    const picks = brief.picks.map((pick) =>
      pick.answer
        ? `- ${pick.question} ${pick.answer}`
        : `- ${pick.question} Either is fine.`,
    );
    if (picks.length) lines.push("", "The person's choices:", ...picks);
    if (brief.context.length)
      lines.push(
        "",
        "Their other open tasks (context only, do not do them):",
        ...brief.context.map((title) => `- ${title}`),
      );
    return lines.join("\n");
  }
}
