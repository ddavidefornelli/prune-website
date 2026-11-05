import {
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import { ESTIMATE, MOBILE_QUERY, PLANNER_LIMITS } from "../constants";
import { formatMinutes, parseQuickEntry } from "../quick-entry";
import { EstimateDial } from "./EstimateDial";

interface TaskFormProps {
  busy: boolean;
  autofocus?: boolean;
  onCreate: (outcome: string, minutes: number) => Promise<boolean>;
}

export function TaskForm(props: TaskFormProps) {
  const [outcome, setOutcome] = createSignal("");
  const [minutes, setMinutes] = createSignal<number>(ESTIMATE.defaultMinutes);
  const [mobileMinutes, setMobileMinutes] = createSignal<number>(
    ESTIMATE.defaultMinutes,
  );
  const [mobile, setMobile] = createSignal(
    window.matchMedia(MOBILE_QUERY).matches,
  );
  const [estimating, setEstimating] = createSignal(false);
  const questionId = createUniqueId();
  const parsed = () => parseQuickEntry(outcome());
  let input!: HTMLInputElement;

  onMount(() => {
    if (props.autofocus) input.focus();
    const query = window.matchMedia(MOBILE_QUERY);
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    onCleanup(() => query.removeEventListener("change", change));
  });

  async function create(estimate: number): Promise<void> {
    if (props.busy) return;
    if (await props.onCreate(parsed().outcome, estimate)) {
      setOutcome("");
      setMinutes(ESTIMATE.defaultMinutes);
      setMobileMinutes(ESTIMATE.defaultMinutes);
      setEstimating(false);
    }
  }

  return (
    <>
      <form
        class="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          // An empty Add is an invitation to type, not an error to report.
          if (!outcome().trim()) return input.focus();
          if (!event.currentTarget.reportValidity() || props.busy) return;
          const typed = parsed().minutes;
          if (typed !== null) void create(typed);
          else if (mobile()) setEstimating(true);
          else void create(minutes());
        }}
      >
        <label>
          <input
            ref={(element) => (input = element)}
            aria-label="Outcome"
            name="outcome"
            required
            maxLength={PLANNER_LIMITS.outcomeLength}
            placeholder="Add an outcome"
            autocomplete="off"
            enterkeyhint="done"
            value={outcome()}
            disabled={props.busy}
            onInput={(event) => {
              setOutcome(event.currentTarget.value);
              const typed = parsed().minutes;
              if (typed !== null) setMinutes(typed);
            }}
          />
          <Show
            when={parsed().minutes}
            fallback={
              <kbd class="quick-entry-hint" aria-hidden="true">
                N
              </kbd>
            }
          >
            {(typed) => (
              <span class="quick-entry-chip" aria-live="polite">
                {formatMinutes(typed() * 60)}
              </span>
            )}
          </Show>
        </label>
        <Show when={!mobile()}>
          <div class="task-estimate-inline">
            <EstimateDial
              value={minutes()}
              onChange={setMinutes}
              disabled={props.busy}
            />
          </div>
        </Show>
        <button
          type="submit"
          class="add-task"
          classList={{ "is-empty": !outcome().trim() }}
          aria-label="Add task"
          disabled={props.busy}
        >
          Add
        </button>
      </form>
      <Show when={estimating()}>
        <Dialog
          class="pause-dialog task-estimate-dialog"
          aria-labelledby={questionId}
          preventCancel={props.busy}
          onDismiss={() => setEstimating(false)}
        >
          <form
            class="pause-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create(mobileMinutes());
            }}
          >
            <h2 id={questionId}>
              How much time will this task take to complete?
            </h2>
            <EstimateDial
              value={mobileMinutes()}
              onChange={setMobileMinutes}
              disabled={props.busy}
            />
            <button type="submit" disabled={props.busy}>
              Add task
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => setEstimating(false)}
            >
              Cancel
            </button>
          </form>
        </Dialog>
      </Show>
    </>
  );
}
