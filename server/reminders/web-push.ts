// Web Push without dependencies: VAPID (RFC 8292) to identify prune to the
// browser's push service, and aes128gcm payload encryption (RFC 8291) so the
// push service only ever relays ciphertext. WebCrypto only, so the same code
// runs in Deno (Edge Functions) and in Node (tests).
import { HTTP_STATUS } from "../../src/shared/api-routes.ts";
import { WEB_PUSH } from "../constants.ts";

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

/** Byte sizes fixed by P-256, WebCrypto and RFC 8291. */
const SIZES = {
  publicKey: 65,
  coordinate: 32,
  authSecret: 16,
  salt: 16,
  contentKey: 16,
  nonce: 12,
  sharedSecret: 32,
  /** Header: salt, record size (4 bytes), key length (1 byte). */
  header: 21,
  /** Header plus key plus the AEAD tag and padding delimiter. */
  overhead: 86,
} as const;
const BITS_PER_BYTE = 8;
const SECONDS = 1000;
const BASE64_BLOCK = 4;
/** Marks the last (and only) record. */
const LAST_RECORD = 2;
const DEFAULT_TOPIC = "prune";
const encoder = new TextEncoder();

/** Base64url as Web Push and VAPID write it: no padding. */
export class Base64Url {
  static encode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

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
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The cryptography a push message needs. */
export class WebPushCrypto {
  /** RFC 8291 content encryption: one aes128gcm record. */
  static async encrypt(
    plaintext: Uint8Array,
    target: Pick<PushTarget, "p256dh" | "auth">,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const receiverPublic = Base64Url.decode(target.p256dh);
    const authSecret = Base64Url.decode(target.auth);
    if (
      receiverPublic.length !== SIZES.publicKey ||
      authSecret.length !== SIZES.authSecret
    )
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
        SIZES.sharedSecret * BITS_PER_BYTE,
      ),
    );
    const ikm = await WebPushCrypto.hkdf(
      authSecret,
      shared,
      concat(encoder.encode("WebPush: info\0"), receiverPublic, localPublic),
      SIZES.sharedSecret,
    );
    const salt = crypto.getRandomValues(new Uint8Array(SIZES.salt));
    const cek = await WebPushCrypto.hkdf(
      salt,
      ikm,
      encoder.encode("Content-Encoding: aes128gcm\0"),
      SIZES.contentKey,
    );
    const nonce = await WebPushCrypto.hkdf(
      salt,
      ikm,
      encoder.encode("Content-Encoding: nonce\0"),
      SIZES.nonce,
    );
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
      "encrypt",
    ]);
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        key,
        concat(plaintext, new Uint8Array([LAST_RECORD])),
      ),
    );
    if (cipher.length + SIZES.overhead > WEB_PUSH.recordSize)
      throw new Error("Payload too large");
    const header = new Uint8Array(SIZES.header);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(SIZES.salt, WEB_PUSH.recordSize);
    header[SIZES.header - 1] = localPublic.length;
    return concat(header, localPublic, cipher);
  }

  /** VAPID Authorization header for one push service origin. */
  static async vapidAuthorization(
    endpoint: string,
    keys: VapidKeys,
    nowSeconds = Math.floor(Date.now() / SECONDS),
  ): Promise<string> {
    const publicKey = Base64Url.decode(keys.publicKey);
    if (publicKey.length !== SIZES.publicKey)
      throw new Error("Invalid VAPID public key");
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: keys.privateKey,
        x: Base64Url.encode(publicKey.slice(1, 1 + SIZES.coordinate)),
        y: Base64Url.encode(publicKey.slice(1 + SIZES.coordinate)),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const part = (value: unknown) =>
      Base64Url.encode(encoder.encode(JSON.stringify(value)));
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
      aud: new URL(endpoint).origin,
      exp: nowSeconds + WEB_PUSH.vapidLifetimeSeconds,
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
    return `vapid t=${unsigned}.${Base64Url.encode(signature)}, k=${keys.publicKey}`;
  }

  private static async hkdf(
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
        length * BITS_PER_BYTE,
      ),
    );
  }
}

/** Delivers notifications through each browser's push service. */
export class WebPushSender {
  private readonly keys: VapidKeys;
  private readonly fetcher: typeof fetch;

  constructor(keys: VapidKeys, fetcher: typeof fetch = fetch) {
    this.keys = keys;
    this.fetcher = fetcher;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    let response: Response;
    try {
      const url = new URL(target.endpoint);
      if (url.protocol !== "https:") return "gone";
      const body = await WebPushCrypto.encrypt(
        encoder.encode(JSON.stringify(payload)),
        target,
      );
      response = await this.fetcher(target.endpoint, {
        method: "POST",
        headers: {
          Authorization: await WebPushCrypto.vapidAuthorization(
            target.endpoint,
            this.keys,
          ),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(WEB_PUSH.ttlSeconds),
          Urgency: "high",
          Topic:
            payload.tag
              .replace(/[^A-Za-z0-9_-]/g, "")
              .slice(0, WEB_PUSH.topicLength) || DEFAULT_TOPIC,
        },
        body,
        signal: AbortSignal.timeout(WEB_PUSH.timeoutMs),
      });
    } catch {
      return "failed";
    }
    await response.body?.cancel().catch(() => {});
    if (response.ok) return "sent";
    return response.status === HTTP_STATUS.notFound ||
      response.status === HTTP_STATUS.gone
      ? "gone"
      : "failed";
  }
}
