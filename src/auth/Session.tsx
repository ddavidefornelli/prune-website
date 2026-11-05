import { Match, Switch } from "solid-js";
import { LoadingIndicator } from "../components/LoadingIndicator";
import PixelBackground from "../components/PixelBackground";
import { PlanningClient } from "../planner/api";
import { Planner } from "../planner/Planner";
import { createSession } from "./create-session";
import { SignIn } from "./SignIn";

export function Session() {
  const client = new PlanningClient();
  const session = createSession(client);

  return (
    <Switch>
      <Match when={session.phase() === "restoring"}>
        <LoadingIndicator />
      </Match>
      <Match when={session.account()}>
        {(account) => <Planner client={client} account={account()} />}
      </Match>
      <Match when={session.phase() === "ready"}>
        <PixelBackground completionLevel={0} />
        <div id="app">
          <SignIn
            client={client}
            initialError={session.initialError()}
            configurationError={session.configurationError}
          />
        </div>
      </Match>
    </Switch>
  );
}
