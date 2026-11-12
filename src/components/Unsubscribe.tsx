import { createSignal, Match, Switch } from "solid-js";
import { webConfig } from "../planner/config";
import { SUPABASE_ROUTES } from "../shared/api-routes";

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UnsubscribeRequest = { token: string; kind: "daily" | "comeback" };

/** Reads the link from a reminder email: /?unsubscribe=<token>&kind=<kind>. */
export function unsubscribeRequest(search: string): UnsubscribeRequest | null {
  const params = new URLSearchParams(search);
  const token = params.get("unsubscribe");
  const kind = params.get("kind");
  if (!token || !TOKEN.test(token)) return null;
  if (kind !== "daily" && kind !== "comeback") return null;
  return { token, kind };
}

/**
 * Asks before turning the emails off, so a mail scanner that only opens the
 * link changes nothing. Works signed out: the token in the link is the proof.
 */
export function Unsubscribe(props: { request: UnsubscribeRequest }) {
  const [state, setState] = createSignal<"ask" | "busy" | "done" | "failed">(
    "ask",
  );
  const name = () =>
    props.request.kind === "daily" ? "daily reminder" : "come-back";

  const confirm = async () => {
    setState("busy");
    try {
      const url = new URL(SUPABASE_ROUTES.emailUnsubscribe, webConfig().url);
      url.searchParams.set("token", props.request.token);
      url.searchParams.set("kind", props.request.kind);
      const response = await fetch(url, { method: "POST" });
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <main class="unsubscribe-page">
      <Switch>
        <Match when={state() === "done"}>
          <h1>Done.</h1>
          <p>You will not get {name()} emails from prune any more.</p>
          <p class="muted">
            You can turn them back on in your profile at any time.
          </p>
          <a href="/">Open prune</a>
        </Match>
        <Match when={state() !== "done"}>
          <h1>Stop {name()} emails?</h1>
          <p>prune will stop sending you this email.</p>
          <button
            type="button"
            class="unsubscribe-confirm"
            disabled={state() === "busy"}
            onClick={() => void confirm()}
          >
            {state() === "busy" ? "Stopping…" : "Stop these emails"}
          </button>
          <p class="error" role="alert" hidden={state() !== "failed"}>
            Could not reach prune. Check your connection and try again.
          </p>
          <a href="/">Keep them and open prune</a>
        </Match>
      </Switch>
    </main>
  );
}
