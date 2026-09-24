export const WIDTH = 10;
export const HEIGHT = 20;
export const HIDDEN_ROWS = 2;
export const ROWS = HEIGHT + HIDDEN_ROWS;
export const PIECES = ["I", "O", "T", "S", "Z", "J", "L"] as const;

export type PieceType = (typeof PIECES)[number];
export type Cell = PieceType | "G" | null;
export type Board = Cell[][];
export type GameStatus = "playing" | "paused" | "over";
export type GameAction = "left" | "right" | "clockwise" | "counterclockwise" | "softDrop" | "hardDrop" | "hold";
export type GameEvent =
  | { type: "move" | "rotate" | "hold" }
  | { type: "hardDrop"; from: Point[]; to: Point[]; piece: PieceType; distance: number }
  | { type: "lock"; cells: Point[]; piece: PieceType }
  | { type: "clear"; rows: number[]; count: number; points: number; combo: number }
  | { type: "levelUp"; level: number }
  | { type: "gameOver" };

export interface Point {
  x: number;
  y: number;
}

export interface ActivePiece {
  type: PieceType;
  x: number;
  y: number;
  rotation: 0 | 1 | 2 | 3;
}

export interface GameState {
  board: Board;
  active: ActivePiece | null;
  queue: PieceType[];
  held: PieceType | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  status: GameStatus;
  seed: number;
  rngState: number;
  gravityElapsed: number;
  lockElapsed: number;
  lockResets: number;
  lockDelayStarted: boolean;
  piecesPlaced: number;
  combo: number;
}

export interface GameSnapshot {
  state: GameState;
  remainingBag: PieceType[];
}
