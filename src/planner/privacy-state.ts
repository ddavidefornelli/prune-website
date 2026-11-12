/** Bump alongside PRIVACY.md whenever a newly presented notice is required. */
export const PRIVACY_POLICY_VERSION = "privacy-web-v15";
export const PRIVACY_ACKNOWLEDGEMENT_KEY = "prune:privacy:acknowledgement";

export interface PrivacyAcknowledgement {
  version: string;
  acknowledgedAt: string;
}

/** Device-local terms acceptance and privacy acknowledgement, never AI consent. */
export function hasPrivacyAcknowledgement(
  storage: Pick<Storage, "getItem">,
): boolean {
  try {
    const saved: unknown = JSON.parse(
      storage.getItem(PRIVACY_ACKNOWLEDGEMENT_KEY) ?? "null",
    );
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("version" in saved) ||
      !("acknowledgedAt" in saved)
    )
      return false;
    if (
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

/** Every sign-in entry point records acceptance first, or explains why it cannot. */
export function requirePrivacyAcknowledgement(
  storage: Pick<Storage, "getItem" | "setItem">,
): void {
  if (hasPrivacyAcknowledgement(storage)) return;
  try {
    acknowledgePrivacy(storage);
  } catch {
    throw new Error(
      "Could not save your terms acceptance. Allow browser storage and try again. No sign-in request was sent.",
    );
  }
}

/** Let storage errors reach the gate: do not proceed after a failed durable save. */
export function acknowledgePrivacy(
  storage: Pick<Storage, "setItem">,
  now = new Date(),
): void {
  const record: PrivacyAcknowledgement = {
    version: PRIVACY_POLICY_VERSION,
    acknowledgedAt: now.toISOString(),
  };
  storage.setItem(PRIVACY_ACKNOWLEDGEMENT_KEY, JSON.stringify(record));
}
