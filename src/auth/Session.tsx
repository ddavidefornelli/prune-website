import { createEffect, Match, Switch } from "solid-js";
import { identifyAccount } from "../analytics.ts";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { PlanningClient } from "../planner/api";
import { Planner } from "../planner/Planner";
import { createSession } from "./create-session";
import { SignIn } from "./SignIn";

export function Session() {
  const client = new PlanningClient();
  const session = createSession(client);

  // Identify after either session restoration or a completed sign-in. The
  // analytics singleton defers this until optional-analytics consent, if needed.
  createEffect(() => {
    const account = session.account();
    if (account) identifyAccount(account.accountKey, account.email);
  });

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
