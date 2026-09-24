import {
  HIDDEN_ROWS,
  PIECES,
  ROWS,
  WIDTH,
  type ActivePiece,
  type Board,
  type Cell,
  type GameAction,
  type GameEvent,
  type GameSnapshot,
  type GameState,
  type PieceType,
  type Point,
} from "./contracts";

type Offset = readonly [x: number, y: number];
type Rotations = readonly (readonly Offset[])[];
type Rotation = ActivePiece["rotation"];

const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;

function makeRotations(base: readonly Offset[]): Rotations {
  const rotations: Offset[][] = [[...base]];
  for (let rotation = 1; rotation < 4; rotation += 1) {
    const previous = rotations[rotation - 1];
    rotations.push(previous.map(([x, y]): Offset => [2 - y, x]));
  }
  return rotations;
}

const O_OFFSETS: readonly Offset[] = [
  [1, 0],
  [2, 0],
  [1, 1],
  [2, 1],
];

const SHAPES: Record<PieceType, Rotations> = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [O_OFFSETS, O_OFFSETS, O_OFFSETS, O_OFFSETS],
  T: makeRotations([[1, 0], [0, 1], [1, 1], [2, 1]]),
  S: makeRotations([[1, 0], [2, 0], [0, 1], [1, 1]]),
  Z: makeRotations([[0, 0], [1, 0], [1, 1], [2, 1]]),
  J: makeRotations([[0, 0], [0, 1], [1, 1], [2, 1]]),
  L: makeRotations([[2, 0], [0, 1], [1, 1], [2, 1]]),
};

// SRS kick offsets are expressed in screen coordinates (positive y is down).
const JLSTZ_KICKS: Record<string, readonly Offset[]> = {
  "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "1>2": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "2>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "2>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "3>2": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

const I_KICKS: Record<string, readonly Offset[]> = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// The public state intentionally stays limited to the frozen contract. A weak
// map stores the remaining shuffled bag for each live mutable game state.
const remainingBags = new WeakMap<GameState, PieceType[]>();

export function gravityInterval(level: number): number {
  return Math.max(60, Math.round(1000 * 0.8 ** (level - 1)));
}

export function getCells(piece: ActivePiece): Point[] {
  return SHAPES[piece.type][piece.rotation].map(([x, y]) => ({
    x: piece.x + x,
    y: piece.y + y,
  }));
}

function canPlaceAt(
  board: Board,
  type: PieceType,
  x: number,
  y: number,
  rotation: Rotation,
): boolean {
  for (const [offsetX, offsetY] of SHAPES[type][rotation]) {
    const cellX = x + offsetX;
    const cellY = y + offsetY;
    if (cellX < 0 || cellX >= WIDTH || cellY >= ROWS) return false;
    if (cellY >= 0 && board[cellY][cellX] !== null) return false;
  }
  return true;
}

export function getGhostY(game: Pick<GameState, "board" | "active">): number {
  const active = game.active;
  if (!active) return -1;
  let y = active.y;
  while (canPlaceAt(game.board, active.type, active.x, y + 1, active.rotation)) y += 1;
  return y;
}

function nextUint32(game: GameState): number {
  let value = (game.rngState + 0x6d2b79f5) >>> 0;
  game.rngState = value;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return (value ^ (value >>> 14)) >>> 0;
}

function randomBelow(game: GameState, bound: number): number {
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / bound) * bound;
  let value = nextUint32(game);
  while (value >= limit) value = nextUint32(game);
  return value % bound;
}

function shuffledBag(game: GameState): PieceType[] {
  const bag = [...PIECES];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = randomBelow(game, i + 1);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function drawFromBag(game: GameState): PieceType {
  let bag = remainingBags.get(game);
  if (!bag || bag.length === 0) {
    bag = shuffledBag(game);
    remainingBags.set(game, bag);
  }
  return bag.pop()!;
}

function fillQueue(game: GameState): void {
  while (game.queue.length < 5) game.queue.push(drawFromBag(game));
}

function drawNext(game: GameState): PieceType {
  const next = game.queue.shift()!;
  fillQueue(game);
  return next;
}

function spawn(game: GameState, type: PieceType): boolean {
  const piece: ActivePiece = { type, x: 3, y: 1, rotation: 0 };
  game.gravityElapsed = 0;
  game.lockElapsed = 0;
  game.lockResets = 0;
  game.lockDelayStarted = false;
  if (!canPlaceAt(game.board, type, piece.x, piece.y, piece.rotation)) {
    game.active = null;
    return false;
  }
  game.active = piece;
  return true;
}

export function createGame(seed: number): GameState {
  const game: GameState = {
    board: Array.from({ length: ROWS }, () => Array<null>(WIDTH).fill(null)),
    active: null,
    queue: [],
    held: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    status: "playing",
    seed: seed >>> 0,
    rngState: seed >>> 0,
    gravityElapsed: 0,
    lockElapsed: 0,
    lockResets: 0,
    lockDelayStarted: false,
    piecesPlaced: 0,
    combo: 0,
  };
  remainingBags.set(game, []);
  if (!spawn(game, drawFromBag(game))) game.status = "over";
  fillQueue(game);
  return game;
}

function isPieceType(value: unknown): value is PieceType {
  return typeof value === "string" && (PIECES as readonly string[]).includes(value);
}

function isActivePiece(value: unknown): value is ActivePiece {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const piece = value as Partial<ActivePiece>;
  return (
    isPieceType(piece.type) &&
    typeof piece.x === "number" &&
    Number.isSafeInteger(piece.x) &&
    typeof piece.y === "number" &&
    Number.isSafeInteger(piece.y) &&
    (piece.rotation === 0 || piece.rotation === 1 || piece.rotation === 2 || piece.rotation === 3)
  );
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<GameState>;
  if (!Array.isArray(state.board) || state.board.length !== ROWS) return false;
  for (let y = 0; y < ROWS; y += 1) {
    const row = state.board[y];
    if (!Array.isArray(row) || row.length !== WIDTH) return false;
    for (let x = 0; x < WIDTH; x += 1) {
      if (!(x in row)) return false;
      const cell = row[x];
      if (cell !== null && cell !== "G" && !isPieceType(cell)) return false;
    }
  }
  if (!Array.isArray(state.queue) || state.queue.length !== 5) return false;
  for (let index = 0; index < state.queue.length; index += 1) {
    if (!(index in state.queue) || !isPieceType(state.queue[index])) return false;
  }
  if (state.active !== null && !isActivePiece(state.active)) return false;
  if (state.held !== null && !isPieceType(state.held)) return false;
  if (state.canHold !== true && state.canHold !== false) return false;
  if (state.status !== "playing" && state.status !== "paused" && state.status !== "over") return false;
  if ((state.status === "over") !== (state.active === null)) return false;
  if (
    typeof state.score !== "number" ||
    !Number.isSafeInteger(state.score) ||
    state.score < 0 ||
    typeof state.lines !== "number" ||
    !Number.isSafeInteger(state.lines) ||
    state.lines < 0 ||
    typeof state.level !== "number" ||
    !Number.isSafeInteger(state.level) ||
    state.level < 1 ||
    typeof state.seed !== "number" ||
    !Number.isSafeInteger(state.seed) ||
    state.seed < 0 ||
    state.seed > 0xffff_ffff ||
    typeof state.rngState !== "number" ||
    !Number.isSafeInteger(state.rngState) ||
    state.rngState < 0 ||
    state.rngState > 0xffff_ffff ||
    typeof state.gravityElapsed !== "number" ||
    !Number.isFinite(state.gravityElapsed) ||
    state.gravityElapsed < 0 ||
    typeof state.lockElapsed !== "number" ||
    !Number.isFinite(state.lockElapsed) ||
    state.lockElapsed < 0 ||
    typeof state.lockResets !== "number" ||
    !Number.isSafeInteger(state.lockResets) ||
    state.lockResets < 0 ||
    state.lockResets > MAX_LOCK_RESETS ||
    typeof state.lockDelayStarted !== "boolean" ||
    typeof state.piecesPlaced !== "number" ||
    !Number.isSafeInteger(state.piecesPlaced) ||
    state.piecesPlaced < 0 ||
    typeof state.combo !== "number" ||
    !Number.isSafeInteger(state.combo) ||
    state.combo < 0
  ) return false;
  const active = state.active;
  return (
    active === null ||
    canPlaceAt(state.board as Board, active.type, active.x, active.y, active.rotation)
  );
}


function cloneGameState(game: GameState): GameState {
  return {
    board: game.board.map((row) => [...row]),
    active: game.active ? { ...game.active } : null,
    queue: [...game.queue],
    held: game.held,
    canHold: game.canHold,
    score: game.score,
    lines: game.lines,
    level: game.level,
    status: game.status,
    seed: game.seed,
    rngState: game.rngState,
    gravityElapsed: game.gravityElapsed,
    lockElapsed: game.lockElapsed,
    lockResets: game.lockResets,
    lockDelayStarted: game.lockDelayStarted,
    piecesPlaced: game.piecesPlaced,
    combo: game.combo,
  };
}

export function saveGame(game: GameState): GameSnapshot {
  return {
    state: cloneGameState(game),
    remainingBag: [...(remainingBags.get(game) ?? [])],
  };
}

export function restoreGame(saved: unknown): GameState | null {
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return null;
  const snapshot = saved as Partial<GameSnapshot>;
  if (!isGameState(snapshot.state) || !Array.isArray(snapshot.remainingBag)) return null;
  const state = snapshot.state;
  const remainingBag = snapshot.remainingBag;
  if (remainingBag.length > PIECES.length) return null;
  for (let index = 0; index < remainingBag.length; index += 1) {
    if (!(index in remainingBag) || !isPieceType(remainingBag[index])) return null;
  }
  if (new Set(remainingBag).size !== remainingBag.length) return null;

  const game = cloneGameState(state);
  remainingBags.set(game, [...remainingBag]);
  return game;
}

function isGrounded(game: GameState, piece = game.active): boolean {
  return !!piece && !canPlaceAt(game.board, piece.type, piece.x, piece.y + 1, piece.rotation);
}

function noteSuccessfulTransform(game: GameState, wasGrounded: boolean): void {
  if (!wasGrounded) return;
  game.lockDelayStarted = true;
  if (game.lockResets < MAX_LOCK_RESETS) {
    game.lockResets += 1;
    game.lockElapsed = 0;
  }
}

function moveHorizontal(game: GameState, amount: -1 | 1, emit?: (event: GameEvent) => void): boolean {
  const active = game.active;
  if (!active) return false;
  const wasGrounded = isGrounded(game, active);
  const nextX = active.x + amount;
  if (!canPlaceAt(game.board, active.type, nextX, active.y, active.rotation)) return false;
  active.x = nextX;
  noteSuccessfulTransform(game, wasGrounded);
  emit?.({ type: "move" });
  return true;
}

function rotate(game: GameState, direction: -1 | 1, emit?: (event: GameEvent) => void): boolean {
  const active = game.active;
  if (!active) return false;
  const wasGrounded = isGrounded(game, active);
  const from = active.rotation;
  const to = ((from + direction + 4) % 4) as Rotation;
  const key = `${from}>${to}`;
  const kicks = active.type === "O"
    ? [[0, 0] as const]
    : (active.type === "I" ? I_KICKS : JLSTZ_KICKS)[key];
  for (const [dx, dy] of kicks) {
    const candidateX = active.x + dx;
    const candidateY = active.y + dy;
    if (!canPlaceAt(game.board, active.type, candidateX, candidateY, to)) continue;
    active.x = candidateX;
    active.y = candidateY;
    active.rotation = to;
    noteSuccessfulTransform(game, wasGrounded);
    emit?.({ type: "rotate" });
    return true;
  }
  return false;
}

function clearFullRows(board: Board, clearedRows?: number[]): number {
  let write = ROWS - 1;
  let cleared = 0;
  for (let read = ROWS - 1; read >= 0; read -= 1) {
    const row = board[read];
    if (row.every((cell) => cell !== null)) {
      cleared += 1;
      clearedRows?.push(read);
      continue;
    }
    if (write !== read) board[write] = row;
    write -= 1;
  }
  if (cleared === 0) return 0;
  while (write >= 0) board[write--] = Array<null>(WIDTH).fill(null);
  clearedRows?.reverse();
  return cleared;
}

function markGameOver(game: GameState): boolean {
  if (game.status === "over") return false;
  game.status = "over";
  return true;
}

export function applyGarbage(
  game: GameState,
  holes: readonly number[],
  emit?: (event: GameEvent) => void,
): boolean {
  if (game.status !== "playing" || !Array.isArray(holes) || holes.length === 0) return false;
  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index];
    if (!(index in holes) || !Number.isInteger(hole) || hole < 0 || hole >= WIDTH) return false;
  }

  const count = holes.length;
  let overflow = false;
  for (let y = 0; y < Math.min(count, ROWS); y += 1) {
    if (game.board[y].some((cell) => cell !== null)) {
      overflow = true;
      break;
    }
  }

  const board = game.board.slice(Math.min(count, ROWS));
  for (let row = Math.max(0, count - ROWS); row < count; row += 1) {
    const garbageRow = Array<Cell>(WIDTH).fill("G");
    garbageRow[holes[row]] = null;
    board.push(garbageRow);
  }
  game.board = board;

  const active = game.active;
  if (active) {
    active.y -= count;
    if (!canPlaceAt(game.board, active.type, active.x, active.y, active.rotation)) {
      overflow = true;
    }
  }

  if (overflow) {
    game.active = null;
    if (markGameOver(game)) emit?.({ type: "gameOver" });
  }
  return true;
}

function lockPiece(game: GameState, emit?: (event: GameEvent) => void): void {
  const piece = game.active;
  if (!piece) return;
  const offsets = SHAPES[piece.type][piece.rotation];
  const lockedCells = emit ? getCells(piece) : undefined;
  game.piecesPlaced += 1;
  game.active = null;
  game.gravityElapsed = 0;
  game.lockElapsed = 0;
  game.lockResets = 0;
  game.lockDelayStarted = false;

  for (const [, offsetY] of offsets) {
    if (piece.y + offsetY < 0) {
      game.combo = 0;
      if (emit) emit({ type: "lock", cells: lockedCells!, piece: piece.type });
      if (markGameOver(game)) emit?.({ type: "gameOver" });
      return;
    }
  }
  for (const [offsetX, offsetY] of offsets) {
    game.board[piece.y + offsetY][piece.x + offsetX] = piece.type;
  }
  if (emit) emit({ type: "lock", cells: lockedCells!, piece: piece.type });

  const rows = emit ? [] : undefined;
  const cleared = clearFullRows(game.board, rows);
  const previousLevel = game.level;
  if (cleared > 0) {
    const points = ([0, 100, 300, 500, 800][cleared] ?? 0) * previousLevel;
    game.score += points;
    game.lines += cleared;
    game.level = Math.floor(game.lines / 10) + 1;
    game.combo += 1;
    emit?.({ type: "clear", rows: rows!, count: cleared, points, combo: game.combo });
    if (game.level > previousLevel) emit?.({ type: "levelUp", level: game.level });
  } else {
    game.combo = 0;
  }

  let hiddenBlock = false;
  for (let y = 0; y < HIDDEN_ROWS && !hiddenBlock; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (game.board[y][x] !== null) {
        hiddenBlock = true;
        break;
      }
    }
  }
  if (hiddenBlock) {
    if (markGameOver(game)) emit?.({ type: "gameOver" });
    return;
  }
  game.canHold = true;
  if (!spawn(game, drawNext(game)) && markGameOver(game)) emit?.({ type: "gameOver" });
}

function softDrop(game: GameState, emit?: (event: GameEvent) => void): boolean {
  const active = game.active;
  if (!active) return false;
  if (!canPlaceAt(game.board, active.type, active.x, active.y + 1, active.rotation)) return false;
  active.y += 1;
  game.gravityElapsed = 0;
  game.score += 1;
  emit?.({ type: "move" });
  return true;
}

export function applyAction(
  game: GameState,
  action: GameAction,
  emit?: (event: GameEvent) => void,
): boolean {
  if (game.status !== "playing" || !game.active) return false;
  switch (action) {
    case "left":
      return moveHorizontal(game, -1, emit);
    case "right":
      return moveHorizontal(game, 1, emit);
    case "clockwise":
    case "counterclockwise":
      return rotate(game, action === "clockwise" ? 1 : -1, emit);
    case "softDrop":
      return softDrop(game, emit);
    case "hardDrop": {
      const active = game.active;
      const from = emit ? getCells(active) : undefined;
      const landingY = getGhostY(game);
      const distance = landingY - active.y;
      active.y = landingY;
      game.score += distance * 2;
      if (emit) {
        emit({
          type: "hardDrop",
          from: from!,
          to: getCells(active),
          piece: active.type,
          distance,
        });
      }
      lockPiece(game, emit);
      return true;
    }
    case "hold": {
      if (!game.canHold) return false;
      const currentType = game.active.type;
      const replacement = game.held ?? drawNext(game);
      game.held = currentType;
      game.canHold = false;
      const spawned = spawn(game, replacement);
      const gameOver = !spawned && markGameOver(game);
      emit?.({ type: "hold" });
      if (gameOver) emit?.({ type: "gameOver" });
      return true;
    }
    default:
      return false;
  }
}

export function advance(
  game: GameState,
  elapsedMs: number,
  emit?: (event: GameEvent) => void,
): boolean {
  if (game.status !== "playing" || !game.active || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return false;
  }

  let remaining = elapsedMs;
  let changed = false;
  while (remaining > 0 && game.status === "playing" && game.active) {
    const grounded = isGrounded(game);
    if (grounded) {
      game.gravityElapsed = 0;
      game.lockDelayStarted = true;
    }

    if (game.lockDelayStarted) {
      const interval = gravityInterval(game.level);
      if (game.lockElapsed >= LOCK_DELAY_MS) {
        game.lockElapsed = LOCK_DELAY_MS;
        if (!grounded) game.active.y = getGhostY(game);
        lockPiece(game, emit);
        changed = true;
        continue;
      }
      if (!grounded && game.gravityElapsed + 1e-9 >= interval) {
        game.gravityElapsed = Math.max(0, game.gravityElapsed - interval);
        game.active.y += 1;
        changed = true;
        continue;
      }

      const untilLock = LOCK_DELAY_MS - game.lockElapsed;
      const untilGravity = grounded ? Infinity : interval - game.gravityElapsed;
      const step = Math.min(remaining, untilLock, untilGravity);
      if (step <= 0) break;
      game.lockElapsed += step;
      if (!grounded) game.gravityElapsed += step;
      remaining -= step;

      if (!grounded && game.gravityElapsed + 1e-9 >= interval) {
        game.gravityElapsed = Math.max(0, game.gravityElapsed - interval);
        game.active.y += 1;
        changed = true;
      }
      if (game.lockElapsed + 1e-9 >= LOCK_DELAY_MS) {
        game.lockElapsed = LOCK_DELAY_MS;
        if (!isGrounded(game)) game.active.y = getGhostY(game);
        lockPiece(game, emit);
        changed = true;
      }
      continue;
    }

    const interval = gravityInterval(game.level);
    if (game.gravityElapsed + 1e-9 >= interval) {
      game.gravityElapsed = Math.max(0, game.gravityElapsed - interval);
      game.active.y += 1;
      changed = true;
      continue;
    }
    const step = Math.min(remaining, interval - game.gravityElapsed);
    if (step <= 0) break;
    game.gravityElapsed += step;
    remaining -= step;
    if (game.gravityElapsed + 1e-9 >= interval) {
      game.gravityElapsed = Math.max(0, game.gravityElapsed - interval);
      game.active.y += 1;
      changed = true;
    }
  }
  return changed;
}
