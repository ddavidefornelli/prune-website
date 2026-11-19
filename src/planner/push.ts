// Browser notifications for reminders. Web Push needs a service worker
// (public/sw.js) and the server's VAPID public key, set at build time as
// VITE_VAPID_PUBLIC_KEY. Without the key the UI hides the option; email still works.
import { MEDIA_QUERIES } from "./constants.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

export interface SavedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const SERVICE_WORKER = { url: "/sw.js", scope: "/" } as const;
/** An uncompressed P-256 public key, base64url without padding. */
const VAPID_KEY = /^[A-Za-z0-9_-]{86,88}$/;
const IOS_DEVICE = /iPad|iPhone|iPod/;
const BASE64_BLOCK = 4;

/** Base64url as Web Push and VAPID write it: no padding. */
class Base64Url {
  static decode(value: string): Uint8Array<ArrayBuffer> {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(
      padded +
        "=".repeat(
          (BASE64_BLOCK - (padded.length % BASE64_BLOCK)) % BASE64_BLOCK,
        ),
    );
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  static encode(buffer: ArrayBuffer | null): string {
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

/** This browser's Web Push subscription for reminders. */
export class PushNotifications {
  private readonly readKey: () => string | undefined;

  /** The key is read when first needed: only the browser build has `import.meta.env`. */
  constructor(
    readKey = () => import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined,
  ) {
    this.readKey = readKey;
  }

  private get publicKey(): string | null {
    const key = this.readKey();
    return key && VAPID_KEY.test(key) ? key : null;
  }

  get supported(): boolean {
    return (
      !!this.publicKey &&
      typeof window !== "undefined" &&
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  /** iOS only offers push to sites added to the home screen. */
  static needsHomeScreen(): boolean {
    if (typeof navigator === "undefined") return false;
    const ios =
      IOS_DEVICE.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone =
      window.matchMedia?.(MEDIA_QUERIES.standalone).matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return ios && !standalone && !("PushManager" in window);
  }

  /** This browser's state, without prompting. */
  async state(): Promise<PushState> {
    if (!this.supported) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    try {
      return (await this.subscription()) &&
        Notification.permission === "granted"
        ? "on"
        : "off";
    } catch {
      return "off";
    }
  }

  /**
   * Asks for permission (call only from a click) and subscribes this browser.
   * The caller stores the returned keys on the server.
   */
  async subscribe(): Promise<SavedSubscription | null> {
    const key = this.publicKey;
    if (!key || !this.supported) return null;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
    const worker = await this.registration();
    await navigator.serviceWorker.ready;
    let subscription = await worker.pushManager.getSubscription();
    // A subscription made with an older key can never be delivered to.
    if (
      subscription &&
      Base64Url.encode(subscription.options.applicationServerKey) !== key
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Base64Url.decode(key),
    });
    return {
      endpoint: subscription.endpoint,
      p256dh: Base64Url.encode(subscription.getKey("p256dh")),
      auth: Base64Url.encode(subscription.getKey("auth")),
    };
  }

  /** Turns notifications off in this browser, telling the server first. */
  async forget(remove: (endpoint: string) => Promise<unknown>): Promise<void> {
    try {
      const subscription = await this.subscription();
      if (!subscription) return;
      await remove(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe();
    } catch {
      /* Best effort: the server drops endpoints the browser has dropped. */
    }
  }

  private async registration(): Promise<ServiceWorkerRegistration> {
    const existing = await navigator.serviceWorker.getRegistration(
      SERVICE_WORKER.url,
    );
    return (
      existing ??
      navigator.serviceWorker.register(SERVICE_WORKER.url, {
        scope: SERVICE_WORKER.scope,
      })
    );
  }

  private async subscription(): Promise<PushSubscription | null> {
    if (!this.supported) return null;
    const existing = await navigator.serviceWorker.getRegistration(
      SERVICE_WORKER.url,
    );
    return (await existing?.pushManager.getSubscription()) ?? null;
  }
}

export const pushNotifications = new PushNotifications();
