import { For, Match, Switch, type JSX } from "solid-js";

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "bullets" | "steps"; items: string[] };

const BULLET = /^\s*[-•*]\s+/;
const STEP = /^\s*\d+[.)]\s+/;
const URL_PATTERN = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Groups the helper's plain text into paragraphs, bullet lists and numbered steps. */
function blocks(text: string): Block[] {
  const result: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const last = result.at(-1);
    if (!line.trim()) {
      result.push({ type: "paragraph", lines: [] });
      continue;
    }
    const kind = BULLET.test(line)
      ? "bullets"
      : STEP.test(line)
        ? "steps"
        : null;
    if (kind) {
      const item = line.replace(kind === "bullets" ? BULLET : STEP, "");
      if (last?.type === kind) last.items.push(item);
      else result.push({ type: kind, items: [item] });
    } else if (last?.type === "paragraph") last.lines.push(line);
    else result.push({ type: "paragraph", lines: [line] });
  }
  return result.filter((block) =>
    block.type === "paragraph"
      ? block.lines.length > 0
      : block.items.length > 0,
  );
}

/** Text with its URLs as links; never HTML. */
function linked(text: string): JSX.Element {
  // split() with a capture group puts each URL at an odd index.
  return text.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1 ? (
      <a href={part} target="_blank" rel="noopener noreferrer">
        {part.replace(/^https?:\/\/(www\.)?/, "")}
      </a>
    ) : (
      part
    ),
  );
}

/** The helper's answer, laid out from its plain text. */
export function AnswerText(props: { text: string }) {
  return (
    <div class="answer-text">
      <For each={blocks(props.text)}>
        {(block) => (
          <Switch>
            <Match when={block.type === "paragraph" && block}>
              {(paragraph) => (
                <p>
                  <For each={paragraph().lines}>
                    {(line, index) => (
                      <>
                        {index() > 0 && <br />}
                        {linked(line)}
                      </>
                    )}
                  </For>
                </p>
              )}
            </Match>
            <Match when={block.type === "bullets" && block}>
              {(list) => (
                <ul>
                  <For each={list().items}>
                    {(item) => <li>{linked(item)}</li>}
                  </For>
                </ul>
              )}
            </Match>
            <Match when={block.type === "steps" && block}>
              {(list) => (
                <ol>
                  <For each={list().items}>
                    {(item) => <li>{linked(item)}</li>}
                  </For>
                </ol>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}

/** The first line of an answer, for the row under its task. */
export function preview(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.replace(BULLET, "").replace(STEP, "").trim())
    .find(Boolean);
  return line ?? "";
}
