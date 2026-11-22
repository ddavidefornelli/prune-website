import type Anthropic from "@anthropic-ai/sdk";
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

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

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

/** The model refused or stopped without an answer. */
export class HelperModelError extends Error {}

const CLASSIFY_SYSTEM = `You sort a person's to-do items. For each item, decide whether an assistant that can only write text and search the web could do the useful part of it right now, and what it would make:
- "draft": a message, email, post, letter, bio or other text to write.
- "list": ideas, options, a shopping or packing list, a checklist.
- "plan": steps, a schedule, an itinerary, a routine.
- "research": finding, comparing or explaining facts, places, products or prices.
- "none": anything else: physical errands (buy milk, clean the kitchen), things only the person can do (call mom, pay the bill, go to the gym), private information the assistant cannot see, or items too vague to act on.
Prefer "none" when unsure. An item asking to send, book or buy something still counts when the assistant could prepare it (write the email, find the options).`;

const CHOICES_SYSTEM = `Before an assistant does a task from a person's to-do list, it may ask up to ${HELPER_LIMITS.questions} quick this-or-that questions. Each has exactly two short options the person taps.
Ask only what would clearly change the result and cannot be guessed from the task, the other tasks, the date, the time zone or the language: tone (warm or formal), length (short or detailed), style or look (minimal or bold), budget (cheap or premium), format (bullet list or paragraphs), and so on. When a fact matters (a city, a date), offer the two most likely answers; the person can also type their own.
Ask nothing when the task is already clear. Questions and options are short (options at most four words), written in the language of the task.`;

const ANSWER_SYSTEM = `You do tasks from a person's to-do list and hand back the finished result, ready to use.
- Write the thing itself: the email, the list, the plan, the findings. No preamble, no "Here is", no closing offer of more help.
- Plain text only: short paragraphs, "- " for list items, "1. " for steps. No headings, bold, tables or code blocks. Put links as plain URLs.
- Use web search when the task needs current facts, places, prices or products, and keep to what you found. Say briefly when something should be double-checked.
- You cannot act in the world: never say you sent, booked, bought or called anything. When the task needs that, prepare it so the person can do it in a minute.
- Follow the person's choices. Use the date, time zone and language you are given; write in the language of the task.
- Keep it as short as the task allows.`;

const KIND_DESCRIPTIONS: Record<HelperKind, string> = {
  draft: "a text to write",
  list: "a list",
  plan: "a plan",
  research: "research",
};

/**
 * The helper's three uses of Claude: which tasks it can do, what to ask
 * first, and the answer itself (with web search). Every call has a server-side
 * fallback for refusals.
 */
export class HelperModel {
  private readonly client: Anthropic;

  constructor(client: Anthropic) {
    this.client = client;
  }

  /** The kind of help each task can get, null where it can get none. */
  async classify(
    tasks: { id: string; title: string }[],
  ): Promise<Map<string, HelperKind | null>> {
    const result = new Map<string, HelperKind | null>();
    if (!tasks.length) return result;
    const message = await this.client.beta.messages.create({
      ...HelperModel.base("low", HELPER.classifyTokens),
      system: CLASSIFY_SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    kind: { type: "string", enum: [...HELPER_KINDS, "none"] },
                  },
                  required: ["id", "kind"],
                  additionalProperties: false,
                },
              },
            },
            required: ["items"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            items: tasks.map((task) => ({ id: task.id, item: task.title })),
          }),
        },
      ],
    });
    const parsed = HelperModel.json(message) as {
      items?: { id?: unknown; kind?: unknown }[];
    };
    const known = new Set(tasks.map((task) => task.id));
    for (const task of tasks) result.set(task.id, null);
    for (const item of parsed.items ?? []) {
      if (typeof item.id !== "string" || !known.has(item.id)) continue;
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
    const message = await this.client.beta.messages.create({
      ...HelperModel.base("low", HELPER.choicesTokens),
      system: CHOICES_SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" } },
                  },
                  required: ["question", "options"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: HelperModel.describe(brief) }],
    });
    const parsed = HelperModel.json(message) as {
      questions?: { question?: unknown; options?: unknown }[];
    };
    const clip = (value: string) =>
      value.trim().slice(0, HELPER_LIMITS.choiceLength);
    return (parsed.questions ?? [])
      .filter(
        (item): item is { question: string; options: string[] } =>
          typeof item.question === "string" &&
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
    const messages: MessageParam[] = [
      { role: "user", content: HelperModel.describe(brief) },
    ];
    if (first !== null) messages.push({ role: "assistant", content: first });
    for (const turn of turns)
      messages.push({ role: turn.role, content: turn.text });

    const content: Anthropic.Beta.BetaContentBlock[] = [];
    let message: Message | null = null;
    // Web search can pause a long turn; the API picks up where it stopped.
    for (let round = 0; round < HELPER.maxContinuations; round++) {
      message = await this.client.beta.messages
        .stream({
          ...HelperModel.base(HELPER.effort, HELPER.answerTokens),
          system: ANSWER_SYSTEM,
          tools: [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: HELPER.maxSearches,
            },
          ],
          messages,
        })
        .finalMessage();
      content.push(...message.content);
      if (message.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: message.content });
    }
    if (!message || message.stop_reason === "refusal")
      throw new HelperModelError("refused");

    const sources = new Map<string, HelperSource>();
    // Only the text after the last search (or thinking) is the answer; earlier text is
    // the model thinking aloud between searches.
    let lastOther = -1;
    content.forEach((block, index) => {
      if (block.type !== "text") lastOther = index;
    });
    const text = content
      .slice(lastOther + 1)
      .map((block) => {
        if (block.type !== "text") return "";
        for (const citation of block.citations ?? [])
          if (citation.type === "web_search_result_location")
            sources.set(citation.url, {
              url: citation.url,
              title: citation.title || new URL(citation.url).hostname,
            });
        return block.text;
      })
      .join("")
      .trim();
    if (!text) throw new HelperModelError("empty");
    return {
      answer: text.slice(0, HELPER_LIMITS.answerLength),
      sources: [...sources.values()].slice(0, HELPER.maxSources),
    };
  }

  private static base(effort: "low" | "medium" | "high", maxTokens: number) {
    return {
      model: HELPER.model,
      max_tokens: maxTokens,
      betas: [HELPER.fallbackBeta],
      fallbacks: "default" as const,
      output_config: { effort },
    };
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
    ];
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
    return lines.filter((line, index) => line || index > 0).join("\n");
  }

  private static json(message: Message): unknown {
    if (message.stop_reason === "refusal")
      throw new HelperModelError("refused");
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new HelperModelError("unreadable");
    }
  }
}
