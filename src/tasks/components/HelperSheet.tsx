import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { HELPER_LIMITS } from "../../shared/helper-contract";
import type { HelperFlow, HelperState } from "../helper-state";
import type { ListState } from "../list-state";
import { AnswerText } from "./AnswerText";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);

const Spinner = () => <span class="helper-spinner" aria-hidden="true" />;

/** "Do it for me": the questions and the finished answer. */
export function HelperSheet(props: { helper: HelperState; list: ListState }) {
  const title = (flow: HelperFlow) => props.list.task(flow.taskId)?.title ?? "";

  return (
    <Show when={props.helper.flow()}>
      {(flow) => (
        <Dialog
          class="sheet helper-sheet"
          aria-label="Do it for me"
          onDismiss={() => props.helper.close()}
          onClick={(event) => {
            if (event.target === event.currentTarget) props.helper.close();
          }}
          initialFocus={(dialog) =>
            dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus() ??
            dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus()
          }
        >
          <div class="sheet-body">
            <header class="sheet-header">
              <p class="helper-task">{title(flow())}</p>
              <button
                type="button"
                class="sheet-close"
                aria-label="Close"
                onClick={() => props.helper.close()}
              >
                <CloseIcon />
              </button>
            </header>
            <Switch>
              <Match when={flow().step === "asking"}>
                <p class="helper-status" role="status">
                  <Spinner />
                  Getting ready…
                </p>
              </Match>
              <Match when={flow().step === "choose" && flow()}>
                {(choose) => (
                  <Choices
                    helper={props.helper}
                    flow={choose() as Extract<HelperFlow, { step: "choose" }>}
                  />
                )}
              </Match>
              <Match when={flow().step === "answer"}>
                <Answer helper={props.helper} taskId={flow().taskId} />
              </Match>
            </Switch>
            <Show when={props.helper.error()}>
              <p class="error" role="alert">
                {props.helper.error()}
              </p>
            </Show>
          </div>
        </Dialog>
      )}
    </Show>
  );
}

function Choices(props: {
  helper: HelperState;
  flow: Extract<HelperFlow, { step: "choose" }>;
}) {
  const [typing, setTyping] = createSignal(false);
  const [own, setOwn] = createSignal("");
  const question = () => props.flow.choices[props.flow.picks.length];
  const choose = (answer: string) => {
    setTyping(false);
    setOwn("");
    void props.helper.pick(answer);
  };

  return (
    <Show when={question()} keyed>
      {(current) => (
        <div class="helper-choose">
          <Show when={props.flow.choices.length > 1}>
            <p class="helper-step">
              {props.flow.picks.length + 1} of {props.flow.choices.length}
            </p>
          </Show>
          <h2 class="helper-question">{current.question}</h2>
          <div class="helper-options">
            <For each={current.options}>
              {(option, index) => (
                <button
                  type="button"
                  class="helper-option"
                  data-autofocus={index() === 0 ? "" : undefined}
                  disabled={props.helper.busy()}
                  onClick={() => choose(option)}
                >
                  {option}
                </button>
              )}
            </For>
          </div>
          <Show
            when={typing()}
            fallback={
              <div class="helper-minor">
                <button
                  type="button"
                  class="text-button"
                  disabled={props.helper.busy()}
                  onClick={() => choose("")}
                >
                  Either is fine
                </button>
                <button
                  type="button"
                  class="text-button"
                  disabled={props.helper.busy()}
                  onClick={() => setTyping(true)}
                >
                  Something else
                </button>
              </div>
            }
          >
            <form
              class="helper-field"
              onSubmit={(event) => {
                event.preventDefault();
                if (own().trim()) choose(own());
              }}
            >
              <input
                ref={(element) => queueMicrotask(() => element.focus())}
                type="text"
                aria-label="Your answer"
                placeholder="Your answer"
                maxLength={HELPER_LIMITS.choiceLength}
                enterkeyhint="go"
                value={own()}
                onInput={(event) => setOwn(event.currentTarget.value)}
              />
              <button
                type="submit"
                class="primary-button"
                disabled={!own().trim() || props.helper.busy()}
              >
                OK
              </button>
            </form>
          </Show>
          <Show when={props.helper.busy()}>
            <p class="helper-status" role="status">
              <Spinner />
              Starting…
            </p>
          </Show>
        </div>
      )}
    </Show>
  );
}

function Answer(props: { helper: HelperState; taskId: string }) {
  const run = () => props.helper.run(props.taskId);
  const [message, setMessage] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const refinesLeft = () =>
    HELPER_LIMITS.refines -
    (run()?.turns.filter((turn) => turn.role === "user").length ?? 0);

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Selecting the text by hand still works.
    }
  }

  return (
    <Show when={run()}>
      {(current) => (
        <div class="helper-answer">
          <Show when={current().status === "working"}>
            <p class="helper-status" role="status">
              <Spinner />
              {current().answer === null ? "Working on it…" : "Changing it…"}
            </p>
          </Show>
          <Show when={current().status === "failed"}>
            <div class="helper-failed">
              <p>{current().error ?? "Couldn't finish this one."}</p>
              <button
                type="button"
                class="secondary-button"
                disabled={props.helper.busy()}
                onClick={() => void props.helper.retry(props.taskId)}
              >
                Try again
              </button>
            </div>
          </Show>
          <Show when={current().answer}>
            {(text) => (
              <>
                <AnswerText text={text()} />
                <Show when={current().sources.length}>
                  <ul class="helper-sources" aria-label="Sources">
                    <For each={current().sources}>
                      {(source) => (
                        <li>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {source.title}
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show
                  when={current().status !== "working" && refinesLeft() > 0}
                >
                  <form
                    class="helper-field"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (await props.helper.refine(message())) setMessage("");
                    }}
                  >
                    <input
                      type="text"
                      aria-label="Ask for a change"
                      placeholder="Ask for a change"
                      maxLength={HELPER_LIMITS.messageLength}
                      enterkeyhint="send"
                      value={message()}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                    />
                    <button
                      type="submit"
                      class="secondary-button"
                      disabled={!message().trim() || props.helper.busy()}
                    >
                      Change
                    </button>
                  </form>
                </Show>
                <div class="helper-actions">
                  <button
                    type="button"
                    class="text-button is-danger"
                    disabled={
                      props.helper.busy() || current().status === "working"
                    }
                    onClick={() => void props.helper.discard()}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    class="secondary-button"
                    onClick={() => void copy(text())}
                  >
                    {copied() ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    class="primary-button"
                    data-autofocus=""
                    onClick={() => props.helper.close()}
                  >
                    Keep
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
