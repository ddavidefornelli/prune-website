// Web Push without dependencies: VAPID (RFC 8292) to identify prune to the
// browser's push service, and aes128gcm payload encryption (RFC 8291) so the
// push service only ever relays ciphertext. WebCrypto only, so the same code
// runs in Deno (Edge Functions) and in Node (tests).

export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url. Also the client's applicationServerKey. */
  publicKey: string;
  /** The private scalar d, base64url (32 bytes). */
  privateKey: string;
  /** mailto: or https: contact the push service may use. */
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Opened when the notification is clicked. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
}

/** `gone`: the browser dropped the subscription; forget the endpoint. */
export type PushResult = "sent" | "gone" | "failed";

const SEND_TIMEOUT_MS = 10_000;
const RECORD_SIZE = 4096;
const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      length * 8,
    ),
  );
}

/** RFC 8291 content encryption: one aes128gcm record. */
export async function encryptPayload(
  plaintext: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  if (receiverPublic.length !== 65 || authSecret.length !== 16)
    throw new Error("Invalid push subscription keys");
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const local = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const localPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", local.publicKey),
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiverKey },
      local.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, localPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 marks the last (and only) record.
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  if (cipher.length + 86 > RECORD_SIZE) throw new Error("Payload too large");
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = localPublic.length;
  return concat(header, localPublic, cipher);
}

/** VAPID Authorization header for one push service origin. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const publicKey = fromBase64url(keys.publicKey);
  if (publicKey.length !== 65) throw new Error("Invalid VAPID public key");
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: base64url(publicKey.slice(1, 33)),
      y: base64url(publicKey.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const part = (value: unknown) =>
    base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,
    sub: keys.subject,
  })}`;
  // WebCrypto returns ECDSA signatures as raw r||s, which is what JWS ES256 wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      encoder.encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${base64url(signature)}, k=${keys.publicKey}`;
}

export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
  keys: VapidKeys,
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  let response: Response;
  try {
    const url = new URL(target.endpoint);
    if (url.protocol !== "https:") return "gone";
    const body = await encryptPayload(
      encoder.encode(JSON.stringify(payload)),
      target,
    );
    response = await fetcher(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // A start-time nudge is useless hours later.
        TTL: "3600",
        Urgency: "high",
        Topic:
          payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "prune",
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return "failed";
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return "sent";
  return response.status === 404 || response.status === 410 ? "gone" : "failed";
}
