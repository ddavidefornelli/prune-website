import { createEffect, Match, Switch } from "solid-js";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { PlanningClient } from "../planner/api";
import { Planner } from "../planner/Planner";
import { createSession } from "./create-session";
import { SignIn } from "./SignIn";

export function Session() {
  const client = new PlanningClient();
  const session = createSession(client);

  // The planner lives at the root; don't leave a signed-in visitor on /login.
  createEffect(() => {
    if (session.account() && location.pathname !== "/")
      history.replaceState(null, "", "/");
  });

  return (
    <Switch>
      <Match when={session.phase() === "restoring"}>
        <LoadingIndicator />
      </Match>
      <Match when={session.account()}>
        {(account) => <Planner client={client} account={account()} />}
      </Match>
      <Match when={session.phase() === "ready"}>
        {/* No pixel layer here: at level 0 it draws nothing, yet its 1.2 MB
            mask would be fetched. The CSS artwork still shows behind. */}
        <div id="app" class="is-landing">
          <SignIn
            client={client}
            initialError={session.initialError()}
            configurationError={session.configurationError}
            onAuthenticated={session.authenticate}
          />
        </div>
      </Match>
    </Switch>
  );
}
