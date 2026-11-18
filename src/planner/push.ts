// Browser notifications for start times and reminders. Web Push needs a
// service worker (public/sw.js) and the server's VAPID public key, set at
// build time as VITE_VAPID_PUBLIC_KEY. Without the key every function here
// reports "unsupported" and the UI hides the option; email still works.

const SW_URL = "/sw.js";

export type PushState = "unsupported" | "denied" | "off" | "on";

export interface SavedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function publicKey(): string | null {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  return key && /^[A-Za-z0-9_-]{86,88}$/.test(key) ? key : null;
}

export function pushSupported(): boolean {
  return (
    !!publicKey() &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iOS only offers push to sites added to the home screen. */
export function needsHomeScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone && !("PushManager" in window);
}

function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  return existing ?? navigator.serviceWorker.register(SW_URL, { scope: "/" });
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await existing?.pushManager.getSubscription()) ?? null;
}

/** This browser's state, without prompting. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    return (await currentSubscription()) &&
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
export async function subscribePush(): Promise<SavedSubscription | null> {
  const key = publicKey();
  if (!key || !pushSupported()) return null;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;
  const worker = await registration();
  await navigator.serviceWorker.ready;
  let subscription = await worker.pushManager.getSubscription();
  // A subscription made with an older key can never be delivered to.
  if (
    subscription &&
    toBase64url(subscription.options.applicationServerKey) !== key
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toBytes(key),
  });
  return {
    endpoint: subscription.endpoint,
    p256dh: toBase64url(subscription.getKey("p256dh")),
    auth: toBase64url(subscription.getKey("auth")),
  };
}

/** Turns notifications off in this browser, telling the server first. */
export async function forgetPush(
  remove: (endpoint: string) => Promise<unknown>,
): Promise<void> {
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await remove(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  } catch {
    /* Best effort: the server drops endpoints the browser has dropped. */
  }
}
