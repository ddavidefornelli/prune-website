import { ErrorBoundary, Show } from "solid-js";
import { Unsubscribe, UnsubscribeRequest } from "./components/Unsubscribe";
import { TaskApp } from "./tasks/TaskApp";

export default function App() {
  const unsubscribe = UnsubscribeRequest.fromSearch(location.search);
  // Keep the token out of the address bar, history and any consented analytics.
  if (unsubscribe) history.replaceState(null, "", location.pathname);
  return (
    <ErrorBoundary
      fallback={
        <p class="error" role="alert">
          prune could not start. Reload to try again. Your tasks are still saved
          in this browser.
        </p>
      }
    >
      <Show when={unsubscribe} fallback={<TaskApp />}>
        {(request) => <Unsubscribe request={request()} />}
      </Show>
    </ErrorBoundary>
  );
}
