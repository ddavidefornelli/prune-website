import {
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";
import type { PlanningClient } from "../planner/api.ts";
import { CloudError } from "../planner/cloud-error.ts";
import { PublicConfig } from "../planner/config.ts";
import { MESSAGES } from "../planner/messages.ts";
import { PrivacyNotice } from "../planner/privacy-state.ts";
import { isAccount, type Account } from "../planner/types.ts";

type SessionPhase = "restoring" | "ready";

/**
 * Restores a saved session or completes a Google redirect, once, at startup.
 * `authenticate` opens the account after an emailed code is verified. Create
 * it inside a Solid owner: disposing the owner closes the client.
 */
export class SessionState {
  readonly account: Accessor<Account | undefined>;
  readonly phase: Accessor<SessionPhase>;
  readonly initialError: Accessor<string>;
  /** Set when this build has no usable backend configuration. */
  readonly configurationError: string;

  private readonly client: PlanningClient;
  private readonly setAccount: Setter<Account | undefined>;
  private readonly setPhase: Setter<SessionPhase>;
  private readonly setInitialError: Setter<string>;
  private disposed = false;

  constructor(
    client: PlanningClient,
    configure: () => unknown = PublicConfig.fromEnvironment,
  ) {
    this.client = client;
    const [account, setAccount] = createSignal<Account>();
    const [phase, setPhase] = createSignal<SessionPhase>("restoring");
    const [initialError, setInitialError] = createSignal("");
    this.account = account;
    this.setAccount = setAccount;
    this.phase = phase;
    this.setPhase = setPhase;
    this.initialError = initialError;
    this.setInitialError = setInitialError;
    this.configurationError = SessionState.configurationProblem(configure);
    onCleanup(() => {
      this.disposed = true;
      void client.dispose();
    });
    onMount(() => void this.restore());
  }

  /** Opens a signed-in account. Safe to pass as a callback. */
  readonly authenticate = (signedIn: Account): void => {
    this.setAccount(signedIn);
  };

  private static configurationProblem(configure: () => unknown): string {
    try {
      configure();
      return "";
    } catch (cause) {
      return CloudError.messageOf(cause);
    }
  }

  private async restore(): Promise<void> {
    try {
      // SDK construction can refresh a session; gate even that access.
      if (
        !this.configurationError &&
        new PrivacyNotice(localStorage).isAcknowledged()
      ) {
        // authStatus() strips the callback parameters it completes.
        const status = await this.client.authStatus();
        if (!this.disposed && isAccount(status)) this.setAccount(status);
      }
    } catch (cause) {
      if (!this.disposed)
        this.setInitialError(
          CloudError.messageOf(cause, MESSAGES.restoreFailed),
        );
    } finally {
      if (!this.disposed) this.setPhase("ready");
    }
  }
}
