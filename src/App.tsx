import { ErrorBoundary, Show } from "solid-js";
import { Session } from "./auth/Session";
import { Unsubscribe, UnsubscribeRequest } from "./components/Unsubscribe";

export default function App() {
  const unsubscribe = UnsubscribeRequest.fromSearch(location.search);
  // Keep the token out of the address bar, history and any consented analytics.
  if (unsubscribe) history.replaceState(null, "", location.pathname);
  return (
    <ErrorBoundary
      fallback={
        <p class="error" role="alert">
          prune could not start. Reload to try again. Do not clear browser
          storage if you have unsynced changes.
        </p>
      }
    >
      <Show when={unsubscribe} fallback={<Session />}>
        {(request) => <Unsubscribe request={request()} />}
      </Show>
    </ErrorBoundary>
  );
}
