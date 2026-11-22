import { Show } from "solid-js";
import type { ListState } from "../list-state";

/** After a delete: what happened, and one tap to take it back. */
export function UndoBar(props: { state: ListState }) {
  return (
    <div class="undo-region" aria-live="polite">
      <Show when={props.state.undo()}>
        {(offer) => (
          <div class="undo-bar">
            <span>{offer().message}</span>
            <button type="button" onClick={() => props.state.undoLast()}>
              Undo
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
