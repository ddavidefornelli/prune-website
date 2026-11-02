import { createSignal, onCleanup, onMount } from "solid-js";
import type { PlanningClient } from "../planner/api";
import { webConfig } from "../planner/config.ts";
import { errorMessage } from "../planner/errors.ts";
import { hasPrivacyAcknowledgement } from "../planner/privacy-state.ts";
import { isAccount, type Account } from "../planner/types.ts";
import type { SurveyImport } from "../survey/model.ts";

type SessionPhase = "restoring" | "transferring" | "transferFailed" | "ready";

interface SessionHooks {
  /** Survey answers to send with the guest import, if any. */
  surveyImport?: () => SurveyImport | undefined;
  /** After sign-in and import. `interactive` excludes restored sessions. */
  onSignedIn?: (interactive: boolean, surveyImported: boolean) => void;
}

/** Session restoration and guest transfer have one lifecycle and explicit phases. */
export function createSession(
  client: PlanningClient,
  guestClient: PlanningClient,
  configure: () => unknown = webConfig,
  hooks: SessionHooks = {},
) {
  const [account, setAccount] = createSignal<Account>();
  const [phase, setPhase] = createSignal<SessionPhase>("restoring");
  const [signingIn, setSigningIn] = createSignal(false);
  const [initialError, setInitialError] = createSignal("");
  const [transferError, setTransferError] = createSignal("");
  let disposed = false;
  let interactiveSignIn = false;
  let configurationError = "";
  try {
    configure();
  } catch (cause) {
    configurationError = errorMessage(cause);
  }

  async function finishSignIn(
    status: Account,
    interactive = false,
  ): Promise<void> {
    if (disposed || phase() === "transferring") return;
    interactiveSignIn ||= interactive;
    setAccount(status);
    setPhase("transferring");
    setTransferError("");
    try {
      const imported = await client.importGuestTasks(hooks.surveyImport?.());
      if (!disposed) {
        hooks.onSignedIn?.(interactiveSignIn, imported === true);
        interactiveSignIn = false;
        setSigningIn(false);
        setPhase("ready");
      }
    } catch (cause) {
      if (!disposed) {
        setTransferError(errorMessage(cause));
        setPhase("transferFailed");
      }
    }
  }

  async function signOut(): Promise<void> {
    try {
      await client.signOut();
      if (!disposed) window.location.reload();
    } catch (cause) {
      if (!disposed) setTransferError(errorMessage(cause));
    }
  }

  onCleanup(() => {
    disposed = true;
    void client.dispose();
    void guestClient.dispose();
  });
  onMount(() => {
    async function restore(): Promise<void> {
      try {
        // SDK construction can refresh a session; gate even that access.
        if (!configurationError && hasPrivacyAcknowledgement(localStorage)) {
          // authStatus() strips the callback parameters it completes.
          const callback = new URLSearchParams(window.location.search).has(
            "oauth",
          );
          const status = await client.authStatus();
          if (!disposed && isAccount(status))
            await finishSignIn(status, callback);
        }
      } catch (cause) {
        if (!disposed)
          setInitialError(
            errorMessage(
              cause,
              "Could not restore your session. Sign in again when you are online. Your pending planner changes remain on this device.",
            ),
          );
      } finally {
        if (!disposed && phase() === "restoring") setPhase("ready");
      }
    }
    void restore();
  });

  return {
    account,
    phase,
    signingIn,
    initialError,
    transferError,
    configurationError,
    finishSignIn,
    signOut,
    startSignIn: () => setSigningIn(true),
    continueAsGuest: () => setSigningIn(false),
    retryTransfer: () => {
      const current = account();
      if (current) void finishSignIn(current);
    },
  };
}
