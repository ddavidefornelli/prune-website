import { Match, Show, Switch } from "solid-js";
import { LoadingIndicator } from "../components/LoadingIndicator";
import PixelBackground from "../components/PixelBackground";
import { PlanningClient } from "../planner/api";
import { GUEST_ACCOUNT } from "../planner/guest";
import { Planner } from "../planner/Planner";
import { createSurvey } from "../survey/create-survey";
import { isFreshVisitor, parseFlag } from "../survey/model";
import { Survey } from "../survey/Survey";
import { createSession } from "./create-session";
import { SignIn } from "./SignIn";

export function Session() {
  const client = new PlanningClient();
  const guestClient = new PlanningClient({ guest: true });
  // Off unless VITE_SURVEY_FLOW is "on" or "split" at build time.
  const survey = createSurvey({
    flag: parseFlag(import.meta.env.VITE_SURVEY_FLOW),
    fresh: isFreshVisitor(localStorage),
  });
  const session = createSession(client, guestClient, undefined, {
    surveyImport: survey.importPayload,
    onSignedIn: survey.signedIn,
  });

  return (
    <Switch>
      <Match
        when={
          session.phase() === "restoring" || session.phase() === "transferring"
        }
      >
        <LoadingIndicator />
      </Match>
      <Match when={session.phase() === "transferFailed"}>
        <div id="app">
          <p class="error" role="alert">
            Your guest tasks are still on this device. {session.transferError()}
          </p>
          <button type="button" onClick={session.retryTransfer}>
            Retry Save & sync
          </button>
          <button type="button" onClick={() => void session.signOut()}>
            Sign out
          </button>
        </div>
      </Match>
      <Match when={session.signingIn()}>
        <PixelBackground completionLevel={0} />
        <div id="app">
          <SignIn
            client={client}
            initialError={session.initialError()}
            configurationError={session.configurationError}
            onAuthenticated={(status) =>
              void session.finishSignIn(status, true)
            }
          />
          <button type="button" onClick={session.continueAsGuest}>
            Continue without an account
          </button>
        </div>
      </Match>
      <Match
        when={
          session.phase() === "ready" && !session.account() && survey.visible()
        }
      >
        <PixelBackground completionLevel={0} />
        <div id="app" class="survey-app">
          <Survey
            survey={survey}
            client={client}
            initialError={session.initialError()}
            configurationError={session.configurationError}
          />
        </div>
      </Match>
      <Match when={session.phase() === "ready"}>
        <Show
          when={session.account()}
          fallback={
            <Planner
              client={guestClient}
              account={GUEST_ACCOUNT}
              guest
              onSaveAndSync={session.startSignIn}
            />
          }
        >
          {(account) => <Planner client={client} account={account()} />}
        </Show>
      </Match>
    </Switch>
  );
}
