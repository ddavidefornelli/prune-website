import { REALTIME } from "../shared/api-routes.ts";

/** What the channel needs to listen: the project, its public key, and who is listening. */
export interface RealtimeAccess {
  /** The HTTPS project URL; the socket uses its wss:// twin. */
  url: string;
  publicKey: string;
  userId: string;
  accessToken: string;
}

interface PhoenixMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
  join_ref?: string | null;
}

/**
 * Listens for "this list changed" on the person's private Realtime topic
 * (`list:<user id>`, see 20261127000200_list_realtime.sql) over one plain
 * WebSocket, speaking just enough of Supabase Realtime's Phoenix protocol:
 * join, heartbeat, token refresh, broadcasts. No task content arrives here:
 * a ping means "sync now". Reconnects on its own, gently; the list's
 * half-minute poll covers any gap.
 */
export class ListChannel {
  private readonly getAccess: () => Promise<RealtimeAccess | null>;
  private readonly onChange: () => void;
  private socket: WebSocket | null = null;
  private topic = "";
  private token = "";
  private ref = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private tokenCheck: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private retryMs: number = REALTIME.initialRetryMs;
  private closed = false;

  constructor(
    getAccess: () => Promise<RealtimeAccess | null>,
    onChange: () => void,
  ) {
    this.getAccess = getAccess;
    this.onChange = onChange;
    void this.open();
  }

  /** A fresh access token (after a refresh) keeps the channel authorised. */
  private refreshToken(token: string): void {
    if (!token || token === this.token) return;
    this.token = token;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.push(this.topic, "access_token", { access_token: token });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearInterval(this.tokenCheck);
    clearTimeout(this.reconnect);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private async open(): Promise<void> {
    const access = await this.getAccess().catch(() => null);
    if (this.closed) return;
    if (!access) {
      this.retry();
      return;
    }
    this.topic = `realtime:list:${access.userId}`;
    this.token = access.accessToken;
    const url = new URL(REALTIME.socketPath, access.url);
    url.protocol = "wss:";
    if (access.url.startsWith("http://")) url.protocol = "ws:";
    url.searchParams.set("apikey", access.publicKey);
    url.searchParams.set("vsn", REALTIME.protocolVersion);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = REALTIME.initialRetryMs;
      this.push(
        this.topic,
        "phx_join",
        {
          config: {
            broadcast: { self: false, ack: false },
            presence: { key: "" },
            postgres_changes: [],
            private: true,
          },
          access_token: this.token,
        },
        true,
      );
      this.heartbeat = setInterval(
        () => this.push("phoenix", "heartbeat", {}),
        REALTIME.heartbeatMs,
      );
      // Reading the session refreshes it near expiry; the channel gets the new token.
      this.tokenCheck = setInterval(
        () =>
          void this.getAccess()
            .then((next) => next && this.refreshToken(next.accessToken))
            .catch(() => {}),
        REALTIME.tokenCheckMs,
      );
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => {
      clearInterval(this.heartbeat);
      clearInterval(this.tokenCheck);
      if (this.socket === socket) this.socket = null;
      if (!this.closed) this.retry();
    };
  }

  private receive(data: unknown): void {
    let message: PhoenixMessage;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.topic !== this.topic) return;
    if (message.event === "broadcast") this.onChange();
    // Joined (or back after a reconnect): catch up on what was missed.
    else if (
      message.event === "phx_reply" &&
      message.ref === message.join_ref &&
      message.payload?.status === "ok"
    )
      this.onChange();
    // Refused (no access, expired token) or the server closed the channel.
    else if (
      (message.event === "phx_reply" && message.payload?.status === "error") ||
      message.event === "phx_close" ||
      message.event === "phx_error"
    )
      this.socket?.close();
  }

  private push(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
    join = false,
  ): void {
    const ref = String(++this.ref);
    const message: PhoenixMessage = { topic, event, payload, ref };
    if (join) message.join_ref = ref;
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      // Closing: the reconnect sends it again.
    }
  }

  private retry(): void {
    if (this.closed) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => void this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, REALTIME.maxRetryMs);
  }
}
