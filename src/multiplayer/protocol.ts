import type { ActivePiece, Board, PieceType } from "../game/contracts";

export type Seat = "host" | "guest";
export type MatchPhase = "waiting" | "countdown" | "playing" | "finished";
export type FinishReason = "topout" | "disconnect" | "left";

/** An opponent's renderable state, never a trusted source of attacks or room membership. */
export interface BoardSnapshot {
  board: Board;
  active: ActivePiece | null;
  held: PieceType | null;
  queue: PieceType[];
  score: number;
  lines: number;
  level: number;
  piecesPlaced: number;
}

export interface PlayerSummary {
  name: string;
  connected: boolean;
  ready: boolean;
  score: number;
  lines: number;
  piecesPlaced: number;
}

export interface RoomView {
  code: string;
  you: Seat;
  phase: MatchPhase;
  players: Record<Seat, PlayerSummary | null>;
  seed: number | null;
  startsAt: number | null;
  serverNow: number;
  matchId: number;
  winner: Seat | null;
  finishReason: FinishReason | null;
  pending: Record<Seat, number>;
}

export type ClientMessage =
  | { type: "ready"; ready: boolean }
  | { type: "board"; matchId: number; sequence: number; snapshot: BoardSnapshot }
  | { type: "clear"; matchId: number; placement: number; count: number }
  | { type: "topout"; matchId: number }
  | { type: "leave" };

export type ServerMessage =
  | { type: "room"; room: RoomView }
  | { type: "board"; seat: Seat; snapshot: BoardSnapshot }
  | { type: "garbage"; matchId: number; holes: number[] }
  | { type: "error"; message: string };
