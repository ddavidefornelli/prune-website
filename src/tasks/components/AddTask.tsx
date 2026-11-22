import { createSignal, onMount } from "solid-js";
import { FINE_POINTER, TASK_LIMITS } from "../constants";

/** The one way to add a task: type it, press Enter. The list grows from the top. */
export function AddTask(props: { onAdd: (title: string) => boolean }) {
  const [title, setTitle] = createSignal("");
  let input!: HTMLInputElement;

  // With a keyboard, the page opens ready to type. Phones wait for a tap, so
  // the keyboard does not cover the list on arrival.
  onMount(() => {
    if (window.matchMedia(FINE_POINTER).matches) input.focus();
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (props.onAdd(title())) setTitle("");
    input.focus();
  }

  return (
    <form class="add-task" onSubmit={submit}>
      <button type="submit" class="add-button" aria-label="Add task">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <input
        ref={(element) => (input = element)}
        class="add-input"
        name="task"
        aria-label="New task"
        placeholder="Add a task"
        autocomplete="off"
        enterkeyhint="done"
        maxLength={TASK_LIMITS.titleLength}
        value={title()}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
    </form>
  );
}
