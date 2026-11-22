import { createSignal, Match, Switch } from "solid-js";
import { PublicConfig } from "../cloud/config";
import { SUPABASE_ROUTES } from "../shared/api-routes";

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "session" stays for links in start-time emails sent before focus times. */
const KIND_NAMES = {
  daily: "daily reminder",
  comeback: "come-back",
  session: "start-time",
} as const;
type UnsubscribeKind = keyof typeof KIND_NAMES;

const isKind = (kind: string | null): kind is UnsubscribeKind =>
  kind !== null && Object.hasOwn(KIND_NAMES, kind);

/** The link from a reminder email: /?unsubscribe=<token>&kind=<kind>. */
export class UnsubscribeRequest {
  readonly token: string;
  readonly kind: UnsubscribeKind;

  private constructor(token: string, kind: UnsubscribeKind) {
    this.token = token;
    this.kind = kind;
  }

  static fromSearch(search: string): UnsubscribeRequest | null {
    const params = new URLSearchParams(search);
    const token = params.get("unsubscribe");
    const kind = params.get("kind");
    if (!token || !TOKEN.test(token) || !isKind(kind)) return null;
    return new UnsubscribeRequest(token, kind);
  }

  /** "daily reminder", as the page names the email. */
  get name(): string {
    return KIND_NAMES[this.kind];
  }

  /** Turns the emails off. Works signed out: the token is the proof. */
  async confirm(): Promise<boolean> {
    const url = new URL(
      SUPABASE_ROUTES.emailUnsubscribe,
      PublicConfig.fromEnvironment().url,
    );
    url.searchParams.set("token", this.token);
    url.searchParams.set("kind", this.kind);
    const response = await fetch(url, { method: "POST" });
    return response.ok;
  }
}

/**
 * Asks before turning the emails off, so a mail scanner that only opens the
 * link changes nothing.
 */
export function Unsubscribe(props: { request: UnsubscribeRequest }) {
  const [state, setState] = createSignal<"ask" | "busy" | "done" | "failed">(
    "ask",
  );

  const confirm = async () => {
    setState("busy");
    try {
      setState((await props.request.confirm()) ? "done" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <main class="unsubscribe-page">
      <Switch>
        <Match when={state() === "done"}>
          <h1>Done.</h1>
          <p>
            You will not get {props.request.name} emails from prune any more.
          </p>
          <p class="muted">
            You can turn them back on from your account in prune.
          </p>
          <a href="/">Open prune</a>
        </Match>
        <Match when={state() !== "done"}>
          <h1>Stop {props.request.name} emails?</h1>
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
