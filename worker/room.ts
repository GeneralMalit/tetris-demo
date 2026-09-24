/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type {
  BoardSnapshot,
  ClientMessage,
  FinishReason,
  MatchPhase,
  RoomView,
  Seat,
  ServerMessage,
} from "../src/multiplayer/protocol";
import { PIECES, ROWS, WIDTH } from "../src/game/contracts";

const ROOM_STORAGE_KEY = "room";
const ROOM_CODE_PATTERN = /^[A-Z2-9]{8}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 24;
const MESSAGE_LIMIT_BYTES = 8192;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 120;
const BOARD_INTERVAL_MS = 200;
const RECONNECT_GRACE_MS = 10_000;
const COUNTDOWN_MS = 3_000;
const GARBAGE_DELAY_MS = 5_000;
const MAX_PENDING_GARBAGE = 100;
const SEATS: Seat[] = ["host", "guest"];

export interface WorkerEnv {
  MULTIPLAYER_ROOM: DurableObjectNamespace<GameRoom>;
  ALLOWED_ORIGIN?: string;
}

interface QueuedGarbage {
  hole: number;
  deliverAt: number;
}

interface PlayerState {
  token: string;
  name: string;
  connected: boolean;
  connectionId: string | null;
  disconnectedAt: number | null;
  ready: boolean;
  score: number;
  lines: number;
  piecesPlaced: number;
  snapshot: BoardSnapshot | null;
  lastBoardAt: number;
  lastSequence: number;
  lastPlacement: number;
  messageWindowStart: number;
  messagesInWindow: number;
}

interface PersistedRoom {
  code: string;
  createdAt: number;
  phase: MatchPhase;
  players: Record<Seat, PlayerState | null>;
  expiredTokens: string[];
  seed: number | null;
  startsAt: number | null;
  matchId: number;
  winner: Seat | null;
  finishReason: FinishReason | null;
  pending: Record<Seat, QueuedGarbage[]>;
}

interface SocketAttachment {
  seat: Seat;
  token: string;
  connectionId: string;
}

interface MessageDispatch {
  boards: Array<{ to: Seat; seat: Seat; snapshot: BoardSnapshot }>;
  garbage: Array<{ seat: Seat; matchId: number; holes: number[] }>;
  close: Array<{ socket: WebSocket; code: number; reason: string }>;
}

function createRoomState(code: string): PersistedRoom {
  return {
    code,
    createdAt: Date.now(),
    phase: "waiting",
    players: { host: null, guest: null },
    expiredTokens: [],
    seed: null,
    startsAt: null,
    matchId: 0,
    winner: null,
    finishReason: null,
    pending: { host: [], guest: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(name: string): boolean {
  const length = Array.from(name).length;
  return (
    length > 0 &&
    length <= MAX_NAME_LENGTH &&
    name.trim() === name &&
    name.normalize("NFC") === name &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
  );
}

function validSnapshot(value: unknown): value is BoardSnapshot {
  if (!isRecord(value) || !Array.isArray(value.board) || value.board.length !== ROWS) return false;
  for (const row of value.board) {
    if (!Array.isArray(row) || row.length !== WIDTH) return false;
    for (const cell of row) {
      if (cell !== null && cell !== "G" && !(PIECES as readonly unknown[]).includes(cell)) return false;
    }
  }

  if (value.active !== null) {
    if (!isRecord(value.active)) return false;
    if (!(PIECES as readonly unknown[]).includes(value.active.type)) return false;
    if (
      !Number.isInteger(value.active.x) ||
      !Number.isInteger(value.active.y) ||
      !Number.isInteger(value.active.rotation) ||
      (value.active.rotation as number) < 0 ||
      (value.active.rotation as number) > 3 ||
      (value.active.x as number) < -4 ||
      (value.active.x as number) >= WIDTH ||
      (value.active.y as number) < -ROWS ||
      (value.active.y as number) >= ROWS
    ) {
      return false;
    }
  }

  if (value.held !== null && !(PIECES as readonly unknown[]).includes(value.held)) return false;
  if (
    !Array.isArray(value.queue) ||
    value.queue.length !== 5 ||
    !value.queue.every((piece) => (PIECES as readonly unknown[]).includes(piece))
  ) return false;

  return (
    Number.isSafeInteger(value.score) &&
    (value.score as number) >= 0 &&
    (value.score as number) <= 2_000_000_000 &&
    Number.isSafeInteger(value.lines) &&
    (value.lines as number) >= 0 &&
    (value.lines as number) <= 2_000_000_000 &&
    Number.isSafeInteger(value.level) &&
    (value.level as number) >= 1 &&
    (value.level as number) <= 1000 &&
    Number.isSafeInteger(value.piecesPlaced) &&
    (value.piecesPlaced as number) >= 0 &&
    (value.piecesPlaced as number) <= 10_000_000
  );
}

function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "ready":
      return typeof value.ready === "boolean" ? { type: "ready", ready: value.ready } : null;
    case "board":
      return (
        Number.isSafeInteger(value.matchId) &&
        Number.isSafeInteger(value.sequence) &&
        (value.sequence as number) >= 0 &&
        validSnapshot(value.snapshot)
      )
        ? {
            type: "board",
            matchId: value.matchId as number,
            sequence: value.sequence as number,
            snapshot: value.snapshot,
          }
        : null;
    case "clear":
      return (
        Number.isSafeInteger(value.matchId) &&
        Number.isSafeInteger(value.placement) &&
        (value.placement as number) >= 0 &&
        Number.isInteger(value.count) &&
        (value.count as number) >= 1 &&
        (value.count as number) <= 4
      )
        ? {
            type: "clear",
            matchId: value.matchId as number,
            placement: value.placement as number,
            count: value.count as number,
          }
        : null;
    case "topout":
      return Number.isSafeInteger(value.matchId)
        ? { type: "topout", matchId: value.matchId as number }
        : null;
    case "leave":
      return { type: "leave" };
    default:
      return null;
  }
}

function randomSeed(): number {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return values[0] === 0 ? 1 : values[0];
}

function randomHoles(count: number): number[] {
  const holes: number[] = [];
  const random = new Uint8Array(Math.max(count * 2, 4));
  while (holes.length < count) {
    crypto.getRandomValues(random);
    for (const byte of random) {
      if (byte < 250) holes.push(byte % WIDTH);
      if (holes.length === count) break;
    }
  }
  return holes;
}

function otherSeat(seat: Seat): Seat {
  return seat === "host" ? "guest" : "host";
}

function attackForClear(count: number): number {
  if (count === 2) return 1;
  if (count === 3) return 2;
  if (count === 4) return 4;
  return 0;
}

export class GameRoom extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
  }

  async createRoom(code: string): Promise<boolean> {
    if (!ROOM_CODE_PATTERN.test(code)) return false;
    return this.ctx.blockConcurrencyWhile(() =>
      this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get<PersistedRoom>(ROOM_STORAGE_KEY)) return false;
        await transaction.put(ROOM_STORAGE_KEY, createRoomState(code));
        return true;
      }),
    );
  }

  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<PersistedRoom>(ROOM_STORAGE_KEY)) !== undefined;
  }


  fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/rooms\/([^/]+)\/socket$/.exec(url.pathname);
    if (request.method !== "GET" || !match || !ROOM_CODE_PATTERN.test(match[1].toUpperCase())) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WEBSOCKET_REQUIRED" }, { status: 426 });
    }

    const state = await this.loadRoom();
    if (!state) return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404 });
    const code = match[1].toUpperCase();
    if (state.code !== code) return Response.json({ error: "ROOM_NOT_FOUND" }, { status: 404 });

    const tokenValue = url.searchParams.get("token");
    const rawName = url.searchParams.get("name");
    const token = tokenValue?.toLowerCase() ?? "";
    const name = rawName?.trim().normalize("NFC") ?? "";
    if (!UUID_PATTERN.test(token) || !validName(name)) {
      return this.rejectWebSocket("INVALID_CREDENTIALS");
    }

    const now = Date.now();
    let changed = this.expireDisconnected(state, now);
    const admissionError = this.admissionError(state, token, name);
    if (admissionError !== null) {
      if (changed) {
        await this.persist(state);
        this.broadcastRoom(state);
      }
      return this.rejectWebSocket(admissionError === "ROOM_FULL" ? "ROOM_FULL" : "INVALID_CREDENTIALS");
    }
    let seat = SEATS.find((candidate) => state.players[candidate]?.token === token);
    if (!seat) seat = state.players.host === null ? "host" : "guest";
    const player = state.players[seat];
    const previousSocket = player?.connected ? this.socketFor(player) : null;
    const connectionId = crypto.randomUUID();
    if (player) {
      player.connected = true;
      player.connectionId = connectionId;
      player.disconnectedAt = null;
      player.name = name;
    } else {
      state.players[seat] = this.newPlayer(token, name, connectionId);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = { seat, token, connectionId };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [seat]);

    if (previousSocket && previousSocket !== server) {
      try {
        previousSocket.close(1012, "SESSION_REPLACED");
      } catch {
        // The old peer may already have gone away.
      }
    }

    if (state.phase === "waiting" || state.phase === "finished") this.maybeStartCountdown(state, now);
    const outgoing = this.collectDueGarbage(state, now);
    changed = true;
    await this.persist(state);
    if (changed) this.broadcastRoom(state);
    for (const candidate of SEATS) {
      if (candidate !== seat) {
        const snapshot = state.players[candidate]?.snapshot;
        if (snapshot) this.sendToSeat(state, seat, { type: "board", seat: candidate, snapshot });
      }
    }
    this.sendGarbage(state, outgoing);

    return new Response(null, { status: 101, webSocket: client });
  }

  alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.runAlarm());
  }

  private async runAlarm(): Promise<void> {
    const state = await this.loadRoom();
    if (!state) return;
    const now = Date.now();
    let changed = this.expireDisconnected(state, now);

    if (state.phase === "countdown" && state.startsAt !== null && state.startsAt <= now) {
      state.phase = "playing";
      state.startsAt = null;
      changed = true;
    }

    const outgoing = this.collectDueGarbage(state, now);
    if (outgoing.length > 0) changed = true;
    if (changed) {
      await this.persist(state);
      this.broadcastRoom(state);
      this.sendGarbage(state, outgoing);
      return;
    }
    await this.scheduleAlarm(state);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.handleWebSocketMessage(ws, message));
  }

  private async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.socketAttachment(ws);
    if (!attachment) {
      this.closeSocket(ws, 1008, "INVALID_CREDENTIALS");
      return;
    }
    const state = await this.loadRoom();
    const player = state?.players[attachment.seat];
    if (!state || !player || player.token !== attachment.token || player.connectionId !== attachment.connectionId) {
      this.closeSocket(ws, 1008, "SESSION_REPLACED");
      return;
    }
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MESSAGE_LIMIT_BYTES) {
      this.closeSocket(ws, 1009, "MESSAGE_TOO_LARGE");
      return;
    }

    const now = Date.now();
    if (now - player.messageWindowStart >= MESSAGE_WINDOW_MS || now < player.messageWindowStart) {
      player.messageWindowStart = now;
      player.messagesInWindow = 0;
    }
    player.messagesInWindow += 1;
    if (player.messagesInWindow > MAX_MESSAGES_PER_WINDOW) {
      await this.persist(state);
      this.closeSocket(ws, 1008, "RATE_LIMIT");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(message);
    } catch {
      await this.persist(state);
      this.sendError(ws, "INVALID_MESSAGE");
      return;
    }
    const clientMessage = parseClientMessage(decoded);
    if (!clientMessage) {
      await this.persist(state);
      this.sendError(ws, "INVALID_MESSAGE");
      return;
    }

    const dispatch: MessageDispatch = { boards: [], garbage: [], close: [] };
    switch (clientMessage.type) {
      case "ready":
        this.handleReady(state, attachment.seat, clientMessage, now);
        break;
      case "board":
        this.handleBoard(state, attachment.seat, clientMessage, now, dispatch, ws);
        break;
      case "clear":
        this.handleClear(state, attachment.seat, clientMessage, now, ws);
        break;
      case "topout":
        this.handleTopout(state, attachment.seat, clientMessage, ws);
        break;
      case "leave":
        this.handleLeave(state, attachment.seat, dispatch, ws);
        break;
    }

    await this.persist(state);
    this.broadcastRoom(state);
    for (const packet of dispatch.boards) {
      this.sendToSeat(state, packet.to, { type: "board", seat: packet.seat, snapshot: packet.snapshot });
    }
    this.sendGarbage(state, dispatch.garbage);
    for (const close of dispatch.close) this.closeSocket(close.socket, close.code, close.reason);
  }
  webSocketClose(ws: WebSocket): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.markDisconnected(ws));
  }

  webSocketError(ws: WebSocket): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.markDisconnected(ws));
  }

  private async loadRoom(): Promise<PersistedRoom | null> {
    return (await this.ctx.storage.get<PersistedRoom>(ROOM_STORAGE_KEY)) ?? null;
  }

  private rejectWebSocket(reason: "ROOM_FULL" | "INVALID_CREDENTIALS"): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["rejected"]);
    this.sendError(pair[1], reason);
    this.closeSocket(pair[1], 1008, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private newPlayer(token: string, name: string, connectionId: string): PlayerState {
    return {
      token,
      name,
      connected: true,
      connectionId,
      disconnectedAt: null,
      ready: false,
      score: 0,
      lines: 0,
      piecesPlaced: 0,
      snapshot: null,
      lastBoardAt: 0,
      lastSequence: -1,
      lastPlacement: -1,
      messageWindowStart: Date.now(),
      messagesInWindow: 0,
    };
  }

  private admissionError(state: PersistedRoom, token: string, name: string): string | null {
    if (!UUID_PATTERN.test(token) || !validName(name)) return "INVALID_CREDENTIALS";
    if (state.expiredTokens.includes(token)) return "SESSION_EXPIRED";
    const existing = SEATS.map((seat) => state.players[seat]).find((player) => player?.token === token);
    if (existing) return existing.name === name ? null : "INVALID_CREDENTIALS";
    return state.players.host === null || state.players.guest === null ? null : "ROOM_FULL";
  }

  private maybeStartCountdown(state: PersistedRoom, now: number): void {
    if (state.phase !== "waiting" && state.phase !== "finished") return;
    const host = state.players.host;
    const guest = state.players.guest;
    if (!host?.connected || !guest?.connected || !host.ready || !guest.ready) return;

    state.phase = "countdown";
    state.matchId += 1;
    state.seed = randomSeed();
    state.startsAt = now + COUNTDOWN_MS;
    state.winner = null;
    state.finishReason = null;
    state.pending = { host: [], guest: [] };
    for (const player of [host, guest]) {
      player.ready = false;
      player.score = 0;
      player.lines = 0;
      player.piecesPlaced = 0;
      player.snapshot = null;
      player.lastBoardAt = 0;
      player.lastSequence = -1;
      player.lastPlacement = -1;
    }
  }

  private handleReady(state: PersistedRoom, seat: Seat, message: Extract<ClientMessage, { type: "ready" }>, now: number): void {
    if (state.phase !== "waiting" && state.phase !== "finished") return;
    const player = state.players[seat];
    if (!player?.connected) return;
    player.ready = message.ready;
    this.maybeStartCountdown(state, now);
  }

  private handleBoard(
    state: PersistedRoom,
    seat: Seat,
    message: Extract<ClientMessage, { type: "board" }>,
    now: number,
    dispatch: MessageDispatch,
    socket: WebSocket,
  ): void {
    const player = state.players[seat];
    if (!player || state.phase !== "playing" || message.matchId !== state.matchId) {
      this.sendError(socket, "STALE_MATCH");
      return;
    }
    if (message.sequence <= player.lastSequence) {
      this.sendError(socket, "STALE_SEQUENCE");
      return;
    }
    if (player.lastBoardAt !== 0 && now - player.lastBoardAt < BOARD_INTERVAL_MS) {
      this.sendError(socket, "BOARD_RATE_LIMIT");
      return;
    }
    if (
      message.snapshot.score < player.score ||
      message.snapshot.lines < player.lines ||
      message.snapshot.piecesPlaced < player.piecesPlaced ||
      message.snapshot.lines > message.snapshot.piecesPlaced * 4
    ) {
      this.sendError(socket, "INVALID_SNAPSHOT");
      return;
    }

    player.lastSequence = message.sequence;
    player.lastBoardAt = now;
    player.snapshot = message.snapshot;
    player.score = message.snapshot.score;
    player.lines = message.snapshot.lines;
    player.piecesPlaced = message.snapshot.piecesPlaced;
    dispatch.boards.push({ to: otherSeat(seat), seat, snapshot: message.snapshot });
  }

  private handleClear(
    state: PersistedRoom,
    seat: Seat,
    message: Extract<ClientMessage, { type: "clear" }>,
    now: number,
    socket: WebSocket,
  ): void {
    const player = state.players[seat];
    if (!player || state.phase !== "playing" || message.matchId !== state.matchId) {
      this.sendError(socket, "STALE_MATCH");
      return;
    }
    if (message.placement <= player.lastPlacement) {
      this.sendError(socket, "DUPLICATE_PLACEMENT");
      return;
    }

    const attack = attackForClear(message.count);
    const incoming = state.pending[seat];
    const cancelled = Math.min(attack, incoming.length);
    const remaining = attack - cancelled;
    const opponent = otherSeat(seat);
    if (state.pending[opponent].length + remaining > MAX_PENDING_GARBAGE) {
      this.sendError(socket, "GARBAGE_LIMIT");
      return;
    }

    incoming.splice(0, cancelled);
    if (remaining > 0) {
      const holes = randomHoles(remaining);
      for (const hole of holes) state.pending[opponent].push({ hole, deliverAt: now + GARBAGE_DELAY_MS });
    }
    player.lastPlacement = message.placement;
  }

  private handleTopout(
    state: PersistedRoom,
    seat: Seat,
    message: Extract<ClientMessage, { type: "topout" }>,
    socket: WebSocket,
  ): void {
    if (state.phase !== "playing" || message.matchId !== state.matchId) {
      this.sendError(socket, "STALE_MATCH");
      return;
    }
    this.finishMatch(state, otherSeat(seat), "topout");
  }


  private handleLeave(
    state: PersistedRoom,
    seat: Seat,
    dispatch: MessageDispatch,
    socket: WebSocket,
  ): void {
    const player = state.players[seat];
    if (!player) return;
    if (state.phase === "playing" || state.phase === "countdown") {
      const other = state.players[otherSeat(seat)];
      this.finishMatch(state, other ? otherSeat(seat) : null, "left");
    }
    this.expireToken(state, player.token);
    state.players[seat] = null;
    dispatch.close.push({ socket, code: 1000, reason: "LEFT" });
  }

  private finishMatch(state: PersistedRoom, winner: Seat | null, reason: FinishReason): void {
    state.phase = "finished";
    state.startsAt = null;
    state.winner = winner;
    state.finishReason = reason;
    state.pending = { host: [], guest: [] };
    for (const player of Object.values(state.players)) {
      if (player) player.ready = false;
    }
  }

  private expireDisconnected(state: PersistedRoom, now: number): boolean {
    const expired = SEATS.filter((seat) => {
      const player = state.players[seat];
      return player !== null && !player.connected && player.disconnectedAt !== null && player.disconnectedAt + RECONNECT_GRACE_MS <= now;
    });
    if (expired.length === 0) return false;

    if (state.phase === "playing" || state.phase === "countdown") {
      const stillPresent = SEATS.filter((seat) => !expired.includes(seat) && state.players[seat] !== null);
      this.finishMatch(state, stillPresent.length === 1 ? stillPresent[0] : null, "disconnect");
    }
    for (const seat of expired) {
      const player = state.players[seat];
      if (!player) continue;
      this.expireToken(state, player.token);
      state.players[seat] = null;
      state.pending[seat] = [];
    }
    return true;
  }

  private expireToken(state: PersistedRoom, token: string): void {
    if (!state.expiredTokens.includes(token)) state.expiredTokens.push(token);
  }

  private collectDueGarbage(state: PersistedRoom, now: number): MessageDispatch["garbage"] {
    if (state.phase !== "playing") return [];
    const outgoing: MessageDispatch["garbage"] = [];
    for (const seat of SEATS) {
      const player = state.players[seat];
      if (!player?.connected) continue;
      const due = state.pending[seat].filter((packet) => packet.deliverAt <= now);
      if (due.length === 0) continue;
      state.pending[seat] = state.pending[seat].filter((packet) => packet.deliverAt > now);
      for (let offset = 0; offset < due.length; offset += 4) {
        outgoing.push({
          seat,
          matchId: state.matchId,
          holes: due.slice(offset, offset + 4).map((packet) => packet.hole),
        });
      }
    }
    return outgoing;
  }

  private async markDisconnected(ws: WebSocket): Promise<void> {
    const attachment = this.socketAttachment(ws);
    if (!attachment) return;
    const state = await this.loadRoom();
    const player = state?.players[attachment.seat];
    if (!state || !player || player.connectionId !== attachment.connectionId || player.token !== attachment.token) return;
    player.connected = false;
    player.connectionId = null;
    player.disconnectedAt = Date.now();
    await this.persist(state);
    this.broadcastRoom(state);
  }

  private socketAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (
        attachment &&
        (attachment.seat === "host" || attachment.seat === "guest") &&
        typeof attachment.token === "string" &&
        typeof attachment.connectionId === "string"
      ) {
        return attachment as SocketAttachment;
      }
    } catch {
      return null;
    }
    return null;
  }

  private socketFor(player: PlayerState): WebSocket | null {
    if (!player.connectionId) return null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket);
      if (attachment?.connectionId === player.connectionId && attachment.token === player.token) return socket;
    }
    return null;
  }

  private sendToSeat(state: PersistedRoom, seat: Seat, message: ServerMessage): void {
    const player = state.players[seat];
    if (!player?.connected) return;
    const socket = this.socketFor(player);
    if (socket) this.send(socket, message);
  }

  private broadcastRoom(state: PersistedRoom): void {
    for (const seat of SEATS) {
      const player = state.players[seat];
      if (!player?.connected) continue;
      const socket = this.socketFor(player);
      if (socket) this.send(socket, { type: "room", room: this.roomView(state, seat) });
    }
  }

  private roomView(state: PersistedRoom, you: Seat): RoomView {
    const summary = (player: PlayerState | null) =>
      player
        ? {
            name: player.name,
            connected: player.connected,
            ready: player.ready,
            score: player.score,
            lines: player.lines,
            piecesPlaced: player.piecesPlaced,
          }
        : null;
    return {
      code: state.code,
      you,
      phase: state.phase,
      players: { host: summary(state.players.host), guest: summary(state.players.guest) },
      seed: state.seed,
      startsAt: state.startsAt,
      serverNow: Date.now(),
      matchId: state.matchId,
      winner: state.winner,
      finishReason: state.finishReason,
      pending: { host: state.pending.host.length, guest: state.pending.guest.length },
    };
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, { type: "error", message });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A hibernated peer can close between state lookup and send.
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Closing an already-closed peer is harmless.
    }
  }

  private sendGarbage(state: PersistedRoom, packets: MessageDispatch["garbage"]): void {
    for (const packet of packets) {
      this.sendToSeat(state, packet.seat, { type: "garbage", matchId: packet.matchId, holes: packet.holes });
    }
  }

  private async persist(state: PersistedRoom): Promise<void> {
    await this.ctx.storage.put(ROOM_STORAGE_KEY, state);
    await this.scheduleAlarm(state);
  }

  private async scheduleAlarm(state: PersistedRoom): Promise<void> {
    let next = Number.POSITIVE_INFINITY;
    if (state.phase === "countdown" && state.startsAt !== null) next = Math.min(next, state.startsAt);
    for (const seat of SEATS) {
      const player = state.players[seat];
      if (player && !player.connected && player.disconnectedAt !== null) {
        next = Math.min(next, player.disconnectedAt + RECONNECT_GRACE_MS);
      }
      if (player?.connected && state.phase === "playing") {
        for (const packet of state.pending[seat]) next = Math.min(next, packet.deliverAt);
      }
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
