import { STORAGE_KEYS } from "../shared/storage-keys.ts";
import { MESSAGES } from "./messages.ts";

/** Bump alongside PRIVACY.md whenever a newly presented notice is required. */
export const PRIVACY_POLICY_VERSION = "privacy-web-v22";
export const PRIVACY_ACKNOWLEDGEMENT_KEY = STORAGE_KEYS.privacyAcknowledgement;

interface Acknowledgement {
  version: string;
  acknowledgedAt: string;
}

/**
 * Device-local terms acceptance and privacy acknowledgement, never AI consent.
 * Every sign-in path records it before any SDK or account access.
 */
export class PrivacyNotice {
  private readonly storage: Pick<Storage, "getItem" | "setItem">;

  constructor(storage: Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
  }

  /** True only for the current version with a well-formed timestamp. */
  isAcknowledged(): boolean {
    try {
      const saved: unknown = JSON.parse(
        this.storage.getItem(PRIVACY_ACKNOWLEDGEMENT_KEY) ?? "null",
      );
      if (
        typeof saved !== "object" ||
        saved === null ||
        !("version" in saved) ||
        !("acknowledgedAt" in saved) ||
        saved.version !== PRIVACY_POLICY_VERSION ||
        typeof saved.acknowledgedAt !== "string"
      )
        return false;
      const timestamp = Date.parse(saved.acknowledgedAt);
      return (
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === saved.acknowledgedAt
      );
    } catch {
      return false;
    }
  }

  /** Lets storage errors through: never proceed after a failed durable save. */
  acknowledge(now = new Date()): void {
    const record: Acknowledgement = {
      version: PRIVACY_POLICY_VERSION,
      acknowledgedAt: now.toISOString(),
    };
    this.storage.setItem(PRIVACY_ACKNOWLEDGEMENT_KEY, JSON.stringify(record));
  }

  /** Records acceptance, or explains why sign-in cannot continue. */
  require(): void {
    if (this.isAcknowledged()) return;
    try {
      this.acknowledge();
    } catch {
      throw new Error(MESSAGES.privacyNotSaved);
    }
  }
}
