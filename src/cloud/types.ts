/** Records exchanged with the backend. They stay plain JSON objects. */

/**
 * Whose list this browser syncs. Everyone starts as a guest: a Supabase
 * anonymous user, created on first use, with no email. Accounts made before
 * guests (Google or an emailed code) keep working where they are signed in.
 */
export interface Account {
  /** The project and user id: what the device's list belongs to. */
  accountKey: string;
  /** Null for a guest. */
  email: string | null;
  guest: boolean;
}

/** The browser's way to the backend: authentication and RPC calls. */
export interface CloudTransport {
  onAccountChange: () => void;
  execute<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  dispose(): Promise<void>;
}
