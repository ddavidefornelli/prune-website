import { MESSAGES } from "./messages.ts";

const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]+$/;
/** A legacy anon key is a JWT whose payload says `role: anon`. */
const ANON_ROLE = "anon";
const JWT_PARTS = 3;

/** The Supabase project the browser talks to. Only public values belong in a Vite bundle. */
export class PublicConfig {
  readonly url: string;
  readonly publicKey: string;

  private constructor(url: string, publicKey: string) {
    this.url = url;
    this.publicKey = publicKey;
  }

  /** Validates build-time values. Never accepts a service-role or secret key. */
  static parse(url: unknown, key: unknown): PublicConfig {
    if (typeof url !== "string" || typeof key !== "string" || !url || !key)
      throw new Error(MESSAGES.configMissing);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(MESSAGES.configBadUrl);
    }
    const local = LOCAL_HOSTS.includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" &&
        !(local && parsed.protocol === "http:")) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error(MESSAGES.configUrlShape);
    if (!PublicConfig.isPublicKey(key))
      throw new Error(MESSAGES.configSecretKey);
    return new PublicConfig(parsed.origin, key);
  }

  /** The values this bundle was built with. */
  static fromEnvironment(): PublicConfig {
    return PublicConfig.parse(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
    );
  }

  private static isPublicKey(key: string): boolean {
    if (/\s/.test(key)) return false;
    if (PUBLISHABLE_KEY.test(key)) return true;
    try {
      const parts = key.split(".");
      return (
        parts.length === JWT_PARTS &&
        JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")))
          .role === ANON_ROLE
      );
    } catch {
      return false;
    }
  }
}
