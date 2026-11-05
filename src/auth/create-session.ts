import { createSignal, onCleanup, onMount } from "solid-js";
import type { PlanningClient } from "../planner/api";
import { webConfig } from "../planner/config.ts";
import { errorMessage } from "../planner/errors.ts";
import { hasPrivacyAcknowledgement } from "../planner/privacy-state.ts";
import { isAccount, type Account } from "../planner/types.ts";

type SessionPhase = "restoring" | "ready";

/** Restores a saved session or completes a Google redirect, once, at startup. */
export function createSession(
  client: PlanningClient,
  configure: () => unknown = webConfig,
) {
  const [account, setAccount] = createSignal<Account>();
  const [phase, setPhase] = createSignal<SessionPhase>("restoring");
  const [initialError, setInitialError] = createSignal("");
  let disposed = false;
  let configurationError = "";
  try {
    configure();
  } catch (cause) {
    configurationError = errorMessage(cause);
  }

  onCleanup(() => {
    disposed = true;
    void client.dispose();
  });
  onMount(() => {
    async function restore(): Promise<void> {
      try {
        // SDK construction can refresh a session; gate even that access.
        if (!configurationError && hasPrivacyAcknowledgement(localStorage)) {
          // authStatus() strips the callback parameters it completes.
          const status = await client.authStatus();
          if (!disposed && isAccount(status)) setAccount(status);
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
        if (!disposed) setPhase("ready");
      }
    }
    void restore();
  });

  return { account, phase, initialError, configurationError };
}
