import { PIECES, ROWS, WIDTH } from "../game/contracts";
import type {
  BoardSnapshot,
  ClientMessage,
  PlayerSummary,
  RoomView,
  Seat,
  ServerMessage,
} from "./protocol";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface MultiplayerClientCallbacks {
  onMessage: (message: ServerMessage) => void;
  onConnection: (state: ConnectionState) => void;
  onError: (message: string) => void;
}

interface ConnectionIdentity {
  code: string;
  name: string;
  token: string;
}

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

const SEATS = ["host", "guest"] as const;
const PHASES = ["waiting", "countdown", "playing", "finished"] as const;
const FINISH_REASONS = ["topout", "disconnect", "left"] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSeat(value: unknown): value is Seat {
  return value === "host" || value === "guest";
}

function isPlayerSummary(value: unknown): value is PlayerSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string" &&
    "connected" in value &&
    typeof value.connected === "boolean" &&
    "ready" in value &&
    typeof value.ready === "boolean" &&
    "score" in value &&
    isFiniteNumber(value.score) &&
    "lines" in value &&
    isFiniteNumber(value.lines) &&
    "piecesPlaced" in value &&
    isFiniteNumber(value.piecesPlaced)
  );
}

function isRoomView(value: unknown): value is RoomView {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !("you" in value) ||
    !isSeat(value.you) ||
    !("phase" in value) ||
    !PHASES.includes(value.phase as (typeof PHASES)[number]) ||
    !("players" in value) ||
    typeof value.players !== "object" ||
    value.players === null ||
    Array.isArray(value.players) ||
    !("pending" in value) ||
    typeof value.pending !== "object" ||
    value.pending === null ||
    Array.isArray(value.pending) ||
    !("serverNow" in value) ||
    !isFiniteNumber(value.serverNow) ||
    !("matchId" in value) ||
    !isFiniteNumber(value.matchId) ||
    !("seed" in value) ||
    !(value.seed === null || isFiniteNumber(value.seed)) ||
    !("startsAt" in value) ||
    !(value.startsAt === null || isFiniteNumber(value.startsAt)) ||
    !("winner" in value) ||
    !(value.winner === null || isSeat(value.winner)) ||
    !("finishReason" in value) ||
    !(
      value.finishReason === null ||
      FINISH_REASONS.includes(value.finishReason as (typeof FINISH_REASONS)[number])
    )
  ) {
    return false;
  }

  const players = value.players as Record<Seat, unknown>;
  const pending = value.pending as Record<Seat, unknown>;
  return SEATS.every((seat) => {
    const player = players[seat];
    return (player === null || isPlayerSummary(player)) && isFiniteNumber(pending[seat]);
  });
}

function isBoardSnapshot(value: unknown): value is BoardSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("board" in value) ||
    !Array.isArray(value.board) ||
    value.board.length !== ROWS ||
    !("active" in value) ||
    !(
      value.active === null ||
      (typeof value.active === "object" &&
        value.active !== null &&
        !Array.isArray(value.active) &&
        "type" in value.active &&
        PIECES.includes(value.active.type as (typeof PIECES)[number]) &&
        "x" in value.active &&
        isFiniteNumber(value.active.x) &&
        "y" in value.active &&
        isFiniteNumber(value.active.y) &&
        "rotation" in value.active &&
        [0, 1, 2, 3].includes(value.active.rotation as number))
    ) ||
    !("score" in value) ||
    !isFiniteNumber(value.score) ||
    !("lines" in value) ||
    !isFiniteNumber(value.lines) ||
    !("level" in value) ||
    !isFiniteNumber(value.level) ||
    !("piecesPlaced" in value) ||
    !isFiniteNumber(value.piecesPlaced)
  ) {
    return false;
  }

  return value.board.every(
    (row) =>
      Array.isArray(row) &&
      row.length === WIDTH &&
      row.every(
        (cell) => cell === null || cell === "G" || PIECES.includes(cell as (typeof PIECES)[number]),
      ),
  );
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }

  switch (value.type) {
    case "room":
      return "room" in value && isRoomView(value.room);
    case "board":
      return (
        "seat" in value &&
        isSeat(value.seat) &&
        "snapshot" in value &&
        isBoardSnapshot(value.snapshot)
      );
    case "garbage":
      return (
        "matchId" in value &&
        isFiniteNumber(value.matchId) &&
        "holes" in value &&
        Array.isArray(value.holes) &&
        value.holes.every((hole) => Number.isInteger(hole))
      );
    case "error":
      return "message" in value && typeof value.message === "string";
    default:
      return false;
  }
}

function serverErrorDescription(code: string): string {
  switch (code) {
    case "ROOM_FULL":
      return "This room is full.";
    case "INVALID_ROOM":
    case "ROOM_NOT_FOUND":
      return "This room does not exist or is no longer available.";
    case "INVALID_CREDENTIALS":
      return "The room rejected this reconnect token or player name.";
    case "ORIGIN_FORBIDDEN":
      return "The room server rejected this page's origin.";
    case "SESSION_EXPIRED":
      return "Your reconnect window expired. Join the room again for a new seat.";
    case "BOARD_RATE_LIMIT":
      return "Board updates arrived too quickly. The connection is still active.";
    case "MALFORMED_INPUT":
    case "INVALID_REQUEST":
      return "The room server rejected the request as invalid.";
    case "SESSION_REPLACED":
      return "This room session was replaced by another connection.";
    default:
      return code;
  }
}


function closeReasonDescription(code: number, reason: string): string | null {
  const normalizedReason = reason.trim().toUpperCase();
  if (normalizedReason === "ROOM_FULL") return serverErrorDescription("ROOM_FULL");
  if (normalizedReason === "INVALID_CREDENTIALS") {
    return serverErrorDescription("INVALID_CREDENTIALS");
  }
  if (normalizedReason === "SESSION_REPLACED") {
    return serverErrorDescription("SESSION_REPLACED");
  }
  if (normalizedReason) return reason.trim();
  if (code === 1008) return "The room server rejected this connection.";
  if (code >= 3000 && code <= 4999) {
    return `The room server closed the connection (code ${code}).`;
  }
  return null;
}

function isTerminalClose(code: number, reason: string): boolean {
  const normalizedReason = reason.trim().toUpperCase();
  if (
    normalizedReason === "ROOM_FULL" ||
    normalizedReason === "INVALID_CREDENTIALS" ||
    normalizedReason === "SESSION_REPLACED"
  ) {
    return true;
  }

  if (code === 1000 || (code >= 1002 && code <= 1010 && code !== 1006)) return true;
  return code >= 3000 && code <= 4999;
}

function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export class MultiplayerClient {
  private readonly apiBase: string;
  private readonly callbacks: MultiplayerClientCallbacks;
  private identity: ConnectionIdentity | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private generation = 0;
  private closed = false;
  private connectionState: ConnectionState = "disconnected";

  constructor(apiBase: string, callbacks: MultiplayerClientCallbacks) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.callbacks = callbacks;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  async createRoom(): Promise<string> {
    if (offline()) {
      throw new Error("You are offline. Reconnect to the internet and try creating a room again.");
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/rooms`, { method: "POST" });
    } catch (error) {
      const detail = offline()
        ? "You are offline. Reconnect to the internet and try again."
        : "Could not reach the room server. Check your connection and try again.";
      throw new Error(detail, { cause: error });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const errorCode =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : null;
      const detail = errorCode
        ? serverErrorDescription(errorCode)
        : `The room server returned HTTP ${response.status}.`;
      throw new Error(`Could not create a room: ${detail}`);
    }

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !("code" in body) ||
      typeof body.code !== "string" ||
      body.code.length === 0
    ) {
      throw new Error("Could not create a room: the room server returned an invalid response.");
    }

    return body.code;
  }

  connect(code: string, name: string, token: string): void {
    if (this.closed) return;
    if (!code || !name || !token) {
      this.callbacks.onError("A room code, player name, and reconnect token are required.");
      this.setState("disconnected");
      return;
    }

    const sameIdentity =
      this.identity?.code === code && this.identity.name === name && this.identity.token === token;
    if (sameIdentity && (this.socket !== null || this.reconnectTimer !== null)) return;

    this.generation += 1;
    this.clearReconnectTimer();
    const previousSocket = this.socket;
    this.socket = null;
    if (previousSocket) this.closeSocket(previousSocket, "Session changed");

    this.identity = { code, name, token };
    this.reconnectAttempts = 0;
    this.setState("connecting");
    this.openSocket(this.generation, false);
  }

  send(message: ClientMessage): void {
    const socket = this.socket;
    if (message.type === "leave") {
      if (socket?.readyState === 1) {
        try {
          socket.send(JSON.stringify(message));
        } catch {
          // Intentional cleanup still takes precedence if sending leave fails.
        }
      }
      this.close();
      return;
    }

    if (this.closed || socket?.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? `Could not send room update: ${error.message}` : "Could not send room update.",
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.identity = null;

    const socket = this.socket;
    this.socket = null;
    if (socket) this.closeSocket(socket, "Client closed");
    this.setState("disconnected");
  }

  private openSocket(generation: number, reconnecting: boolean): void {
    if (this.closed || generation !== this.generation || !this.identity) return;

    if (offline()) {
      this.setState("reconnecting");
      this.callbacks.onError("You are offline. The room connection will retry when available.");
      this.scheduleReconnect(generation);
      return;
    }

    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      this.callbacks.onError("Room connections are only available in a browser.");
      this.setState("disconnected");
      return;
    }

    let url: URL;
    try {
      const baseUrl = new URL(`${this.apiBase}/`, window.location.href);
      url = new URL(`rooms/${encodeURIComponent(this.identity.code)}/socket`, baseUrl);
      if (url.protocol === "http:") url.protocol = "ws:";
      else if (url.protocol === "https:") url.protocol = "wss:";
      else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error("The room server URL must use HTTP or HTTPS.");
      }
      url.searchParams.set("token", this.identity.token);
      url.searchParams.set("name", this.identity.name);
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? `Invalid room server URL: ${error.message}` : "Invalid room server URL.",
      );
      this.setState("disconnected");
      return;
    }

    if (!reconnecting) this.setState("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error ? `Could not open the room connection: ${error.message}` : "Could not open the room connection.",
      );
      this.setState("disconnected");
      return;
    }

    this.socket = socket;
    let serverErrorReported = false;
    let errorReported = false;

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.reconnectAttempts = 0;
      this.setState("connected");
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (!this.isCurrent(socket, generation)) return;
      if (typeof event.data !== "string") {
        this.callbacks.onError("The room server sent an unsupported message.");
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        this.callbacks.onError("The room server sent invalid JSON.");
        return;
      }

      if (!isServerMessage(value)) return;
      if (value.type === "error") {
        serverErrorReported = true;
        errorReported = true;
        this.callbacks.onError(serverErrorDescription(value.message));
      }
      this.callbacks.onMessage(value);
    };

    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      errorReported = true;
      this.callbacks.onError("The room connection encountered a network error.");
    };

    socket.onclose = (event: CloseEvent) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;

      if (this.closed) return;
      if (isTerminalClose(event.code, event.reason)) {
        const detail = closeReasonDescription(event.code, event.reason);
        if (detail && !serverErrorReported && (!errorReported || event.reason.trim())) {
          this.callbacks.onError(detail);
        }
        this.setState("disconnected");
        return;
      }

      this.setState("reconnecting");
      this.scheduleReconnect(generation);
    };
  }

  private scheduleReconnect(generation: number): void {
    if (this.closed || generation !== this.generation || !this.identity || this.reconnectTimer) return;

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempts, 8),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || generation !== this.generation || !this.identity) return;
      this.openSocket(generation, true);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return !this.closed && generation === this.generation && socket === this.socket;
  }

  private closeSocket(socket: WebSocket, reason: string): void {
    try {
      socket.close(1000, reason);
    } catch {
      // A stale or already-closing socket needs no further cleanup.
    }
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.callbacks.onConnection(state);
  }
}
