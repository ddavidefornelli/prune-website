import { createSignal, onCleanup, Show, untrack } from "solid-js";
import { ProductPreview } from "../components/ProductPreview";
import type { PlanningClient } from "../planner/api";
import type { Account } from "../planner/types";
import { Login } from "./Login";

interface SignInProps {
  client: PlanningClient;
  initialError: string;
  configurationError: string;
  onAuthenticated: (account: Account) => void;
}

const LOGIN_PATH = "/login";
const onLoginPath = () => /^\/login\/?$/.test(location.pathname);

/**
 * The signed-out site: the landing page at `/` and the login page at `/login`.
 * A failed sign-in returns to `/`, so that error opens the login page too:
 * it is the only place that can show it.
 */
export function SignIn(props: SignInProps) {
  const failed = !!untrack(() => props.initialError);
  if (failed && !onLoginPath()) history.replaceState(null, "", LOGIN_PATH);
  const [loginOpen, setLoginOpen] = createSignal(failed || onLoginPath());

  const syncWithUrl = () => setLoginOpen(onLoginPath());
  window.addEventListener("popstate", syncWithUrl);
  onCleanup(() => window.removeEventListener("popstate", syncWithUrl));

  function navigate(event: MouseEvent, path: string): void {
    // Leave new-tab and new-window clicks to the browser.
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    history.pushState(null, "", path);
    syncWithUrl();
    window.scrollTo(0, 0);
  }

  return (
    <Show
      when={loginOpen()}
      fallback={
        <div class="landing">
          <h1>
            DO LESS. <br class="landing-break" />
            ACHIEVE MORE.
          </h1>
          <p class="landing-subtitle">
            Time is limited. Stop wasting time on stuff that doesn't move you
            forward.
          </p>
          <ProductPreview />
          <a
            class="landing-cta"
            href={LOGIN_PATH}
            onClick={(event) => navigate(event, LOGIN_PATH)}
          >
            Get started
          </a>
        </div>
      }
    >
      <Login
        client={props.client}
        initialError={props.initialError}
        configurationError={props.configurationError}
        onAuthenticated={props.onAuthenticated}
        onBack={(event) => navigate(event, "/")}
      />
    </Show>
  );
}
