// Browser notifications: one come-back notification a day (see
// supabase/migrations/20261130000100_daily_push.sql). Web Push needs the
// service worker (public/sw.js) and the server's VAPID public key, set at
// build time as VITE_VAPID_PUBLIC_KEY; without it nothing here asks or
// subscribes. iOS offers push only to sites added to the home screen.

const SW_URL = "/sw.js";
const KEY_PATTERN = /^[A-Za-z0-9_-]{86,88}$/;

/** What the server stores to reach this browser. */
export interface SavedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushNotifications {
  private static asked = false;

  private static publicKey(): string | null {
    const key = import.meta.env?.VITE_VAPID_PUBLIC_KEY as string | undefined;
    return key && KEY_PATTERN.test(key) ? key : null;
  }

  static supported(): boolean {
    return (
      !!PushNotifications.publicKey() &&
      typeof window !== "undefined" &&
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  static get granted(): boolean {
    return (
      PushNotifications.supported() && Notification.permission === "granted"
    );
  }

  /**
   * Asks for permission as soon as prune opens. Browsers that only ask after
   * a tap (Safari, Firefox) get the question on the first tap instead. Once
   * per page load, and never after an answer.
   */
  static askOnOpen(onGranted: () => void): void {
    if (PushNotifications.asked || !PushNotifications.supported()) return;
    if (Notification.permission !== "default") return;
    PushNotifications.asked = true;
    const ask = async (): Promise<boolean> => {
      try {
        if ((await Notification.requestPermission()) === "granted") onGranted();
      } catch {
        // Refused without a tap: the first tap asks again.
      }
      return Notification.permission !== "default";
    };
    void ask().then((answered) => {
      if (answered) return;
      document.addEventListener("click", () => void ask(), {
        once: true,
        capture: true,
      });
    });
  }

  /** This browser's subscription, made if needed; null without permission. */
  static async subscription(): Promise<SavedSubscription | null> {
    const key = PushNotifications.publicKey();
    if (!key || !PushNotifications.granted) return null;
    const worker =
      (await navigator.serviceWorker.getRegistration(SW_URL)) ??
      (await navigator.serviceWorker.register(SW_URL, { scope: "/" }));
    await navigator.serviceWorker.ready;
    let subscription = await worker.pushManager.getSubscription();
    // A subscription made with another key can never be delivered to.
    if (
      subscription &&
      PushNotifications.toBase64url(
        subscription.options.applicationServerKey,
      ) !== key
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: PushNotifications.toBytes(key),
    });
    return {
      endpoint: subscription.endpoint,
      p256dh: PushNotifications.toBase64url(subscription.getKey("p256dh")),
      auth: PushNotifications.toBase64url(subscription.getKey("auth")),
    };
  }

  /** Drops this browser's subscription; returns its endpoint, if it had one. */
  static async unsubscribe(): Promise<string | null> {
    if (!PushNotifications.supported()) return null;
    try {
      const worker = await navigator.serviceWorker.getRegistration(SW_URL);
      const subscription = await worker?.pushManager.getSubscription();
      if (!subscription) return null;
      await subscription.unsubscribe();
      return subscription.endpoint;
    } catch {
      return null;
    }
  }

  private static toBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  private static toBase64url(buffer: ArrayBuffer | null): string {
    if (!buffer) return "";
    let binary = "";
    for (const byte of new Uint8Array(buffer))
      binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
}
