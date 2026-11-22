import { createSignal, onCleanup, onMount } from "solid-js";
import { FINE_POINTER, TASK_LIMITS } from "../constants";

/**
 * How much of the layout viewport the on-screen keyboard covers, as
 * --keyboard, so the field pinned to the bottom on phones stays above it.
 */
function trackKeyboard(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const root = document.documentElement;
  const update = () => {
    const covered = window.innerHeight - viewport.height - viewport.offsetTop;
    root.style.setProperty(
      "--keyboard",
      `${Math.max(0, Math.round(covered))}px`,
    );
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    root.style.removeProperty("--keyboard");
  };
}

/**
 * The one way to add a task: type it, press Enter. The list grows from the
 * top; on phones the field sits at the bottom of the screen.
 */
export function AddTask(props: { onAdd: (title: string) => boolean }) {
  const [title, setTitle] = createSignal("");
  let input!: HTMLInputElement;

  // With a keyboard, the page opens ready to type. Phones wait for a tap, so
  // the keyboard does not cover the list on arrival.
  onMount(() => {
    if (window.matchMedia(FINE_POINTER).matches) input.focus();
    onCleanup(trackKeyboard());
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
