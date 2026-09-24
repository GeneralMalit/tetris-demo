import { describe, expect, it } from "vitest";
import { HEIGHT, HIDDEN_ROWS, PIECES, ROWS, WIDTH, type Board, type GameEvent, type GameState, type PieceType } from "./contracts";
import { advance, applyAction, applyGarbage, createGame, getCells, getGhostY, gravityInterval, restoreGame, saveGame } from "./engine";

function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () => Array<PieceType | null>(WIDTH).fill(null));
}

function setActive(
  game: GameState,
  type: PieceType,
  x: number,
  y: number,
  rotation: 0 | 1 | 2 | 3 = 0,
): void {
  game.active = { type, x, y, rotation };
}

function collectDraws(seed: number, count: number): PieceType[] {
  const game = createGame(seed);
  const result = [game.active!.type];
  while (result.length < count) {
    game.board = emptyBoard();
    applyAction(game, "hardDrop");
    expect(game.queue).toHaveLength(5);
    result.push(game.active!.type);
  }
  return result;
}

function collectFollowing(game: GameState, count: number): PieceType[] {
  const result: PieceType[] = [];
  while (result.length < count) {
    result.push(game.active!.type);
    game.board = emptyBoard();
    applyAction(game, "hardDrop");
  }
  return result;
}

describe("game engine", () => {
  it("uses deterministic seven-piece bags and keeps five previews", () => {
    const first = createGame(0x12345678);
    const sameSeed = createGame(0x12345678);
    expect(first.active?.type).toBe(sameSeed.active?.type);
    expect(first.queue).toEqual(sameSeed.queue);
    expect(first.queue).toHaveLength(5);

    const draws = collectDraws(0x12345678, 21);
    expect(collectDraws(0x12345678, 21)).toEqual(draws);
    const zeroSeedBag = collectDraws(0, 7);
    expect(new Set(zeroSeedBag)).toEqual(new Set(PIECES));
    for (let start = 0; start < draws.length; start += 7) {
      expect(new Set(draws.slice(start, start + 7))).toEqual(new Set(PIECES));
    }
  });

  it("restores the remaining bag exactly and isolates snapshots from mutation", () => {
    const original = createGame(0x12345678);
    for (let piece = 0; piece < 3; piece += 1) {
      original.board = emptyBoard();
      applyAction(original, "hardDrop");
    }

    const originalX = original.active!.x;
    const saved = saveGame(original);
    const restored = restoreGame(saved)!;
    saved.state.board[0][0] = "G";
    saved.state.active!.x += 1;
    saved.remainingBag.reverse();

    expect(restored.board[0][0]).toBeNull();
    expect(original.board[0][0]).toBeNull();
    expect(original.active!.x).toBe(originalX);
    expect(collectFollowing(restored, 28)).toEqual(collectFollowing(original, 28));

    const invalid = saveGame(createGame(12));
    invalid.state.board.pop();
    expect(restoreGame(invalid)).toBeNull();

    const invalidBag = saveGame(createGame(13));
    invalidBag.remainingBag = ["I", "I"];
    expect(restoreGame(invalidBag)).toBeNull();
  });

  it("starts every piece with at least one visible cell", () => {
    const seen = new Set<PieceType>();
    for (let seed = 0; seed < 64 && seen.size < PIECES.length; seed += 1) {
      const game = createGame(seed);
      const active = game.active!;
      seen.add(active.type);
      expect(getCells(active).some(({ y }) => y >= HIDDEN_ROWS && y < ROWS)).toBe(true);
    }
    expect(seen).toEqual(new Set(PIECES));
  });

  it("applies SRS kicks, rotates O in place, and rejects blocked moves", () => {
    const tetris = createGame(1);
    setActive(tetris, "T", -1, 5, 1);
    expect(applyAction(tetris, "clockwise")).toBe(true);
    expect(tetris.active).toMatchObject({ x: 0, y: 5, rotation: 2 });

    const line = createGame(2);
    setActive(line, "I", -1, 5, 1);
    expect(applyAction(line, "clockwise")).toBe(true);
    expect(line.active).toMatchObject({ x: 1, y: 5, rotation: 2 });

    const square = createGame(11);
    setActive(square, "O", 3, 5);
    const squareCells = getCells(square.active!);
    expect(applyAction(square, "clockwise")).toBe(true);
    expect(square.active?.rotation).toBe(1);
    expect(getCells(square.active!)).toEqual(squareCells);

    const boundary = createGame(12);
    setActive(boundary, "O", -1, 5);
    expect(applyAction(boundary, "left")).toBe(false);
    expect(boundary.active?.x).toBe(-1);
  });

  it("holds once per piece, swaps the held type, and restores hold after lock", () => {
    const game = createGame(3);
    const firstType = game.active!.type;
    const previewType = game.queue[0];
    expect(applyAction(game, "hold")).toBe(true);
    expect(game.active?.type).toBe(previewType);
    expect(game.held).toBe(firstType);
    expect(game.canHold).toBe(false);
    expect(game.queue).toHaveLength(5);
    expect(applyAction(game, "hold")).toBe(false);

    expect(applyAction(game, "hardDrop")).toBe(true);
    expect(game.canHold).toBe(true);
    const placedType = game.active!.type;
    expect(applyAction(game, "hold")).toBe(true);
    expect(game.active?.type).toBe(firstType);
    expect(game.held).toBe(placedType);
    expect(game.queue).toHaveLength(5);
  });

  it("shows a legal ghost landing and scores soft and hard drops per cell", () => {
    const game = createGame(4);
    setActive(game, "O", 3, 0);
    expect(getGhostY(game)).toBe(HEIGHT);
    expect(applyAction(game, "softDrop")).toBe(true);
    expect(game.active?.y).toBe(1);
    expect(game.score).toBe(1);

    const landingY = getGhostY(game);
    const dropDistance = landingY - game.active!.y;
    expect(applyAction(game, "hardDrop")).toBe(true);
    expect(game.score).toBe(1 + dropDistance * 2);
    expect(game.piecesPlaced).toBe(1);
    expect(game.board[HEIGHT][4]).toBe("O");
    expect(game.board[HEIGHT + 1][5]).toBe("O");
  });

  it("clears adjacent rows together and compacts rows above them", () => {
    const game = createGame(5);
    game.board = emptyBoard();
    game.board[18][2] = "J";
    game.board[19][0] = "L";
    for (const row of [20, 21]) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (x !== 4 && x !== 5) game.board[row][x] = "T";
      }
    }
    setActive(game, "O", 3, 20);

    expect(applyAction(game, "hardDrop")).toBe(true);
    expect(game.lines).toBe(2);
    expect(game.score).toBe(300);
    expect(game.board[20][2]).toBe("J");
    expect(game.board[21][0]).toBe("L");
    expect(game.status).toBe("playing");
  });

  it("shifts the pile and active piece upward, adding garbage at the requested holes", () => {
    const game = createGame(52);
    game.board = emptyBoard();
    game.board[3][2] = "T";
    setActive(game, "O", 3, 17);
    const events: GameEvent[] = [];

    expect(applyGarbage(game, [4, 7], (event) => events.push(event))).toBe(true);

    expect(game.board[1][2]).toBe("T");
    expect(game.active?.y).toBe(15);
    expect(game.board[20]).toEqual(Array.from({ length: WIDTH }, (_, x) => x === 4 ? null : "G"));
    expect(game.board[21]).toEqual(Array.from({ length: WIDTH }, (_, x) => x === 7 ? null : "G"));
    expect(events).toEqual([]);
  });

  it("tops out when garbage discards occupied cells or leaves the active piece colliding with the pile", () => {
    const overflow = createGame(53);
    overflow.board = emptyBoard();
    overflow.board[0][0] = "J";
    const overflowEvents: GameEvent[] = [];
    expect(applyGarbage(overflow, [4], (event) => overflowEvents.push(event))).toBe(true);
    expect(overflow.status).toBe("over");
    expect(overflow.active).toBeNull();
    expect(overflowEvents).toEqual([{ type: "gameOver" }]);

    const liftedPiece = createGame(54);
    liftedPiece.board = emptyBoard();
    setActive(liftedPiece, "O", 3, 1);
    const liftedEvents: GameEvent[] = [];
    expect(applyGarbage(liftedPiece, [1, 2], (event) => liftedEvents.push(event))).toBe(true);
    expect(liftedPiece.active?.y).toBe(-1);
    expect(liftedPiece.status).toBe("playing");
    expect(liftedEvents).toEqual([]);
    const collision = createGame(55);
    collision.board = emptyBoard();
    setActive(collision, "O", 3, 17);
    collision.board[18][4] = "S";
    const collisionEvents: GameEvent[] = [];
    expect(applyGarbage(collision, [8], (event) => collisionEvents.push(event))).toBe(true);
    expect(collision.status).toBe("over");
    expect(collision.active).toBeNull();
    expect(collisionEvents).toEqual([{ type: "gameOver" }]);
  });

  it("emits successful action events and detached hard-drop and lock snapshots", () => {
    const actionGame = createGame(54);
    const actionEvents: GameEvent[] = [];
    setActive(actionGame, "O", -1, 5);
    expect(applyAction(actionGame, "left", (event) => actionEvents.push(event))).toBe(false);
    setActive(actionGame, "O", 3, HEIGHT);
    expect(applyAction(actionGame, "softDrop", (event) => actionEvents.push(event))).toBe(false);
    expect(actionEvents).toEqual([]);
    setActive(actionGame, "T", 3, 5);
    expect(applyAction(actionGame, "right", (event) => actionEvents.push(event))).toBe(true);
    expect(applyAction(actionGame, "clockwise", (event) => actionEvents.push(event))).toBe(true);
    expect(applyAction(actionGame, "hold", (event) => actionEvents.push(event))).toBe(true);
    expect(applyAction(actionGame, "hold", (event) => actionEvents.push(event))).toBe(false);
    expect(actionEvents).toEqual([{ type: "move" }, { type: "rotate" }, { type: "hold" }]);

    const game = createGame(55);
    game.board = emptyBoard();
    setActive(game, "O", 3, 1);
    const events: GameEvent[] = [];
    expect(applyAction(game, "hardDrop", (event) => events.push(event))).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["hardDrop", "lock"]);

    const hardDrop = events[0] as Extract<GameEvent, { type: "hardDrop" }>;
    const lock = events[1] as Extract<GameEvent, { type: "lock" }>;
    expect(hardDrop).toEqual({
      type: "hardDrop",
      from: [{ x: 4, y: 1 }, { x: 5, y: 1 }, { x: 4, y: 2 }, { x: 5, y: 2 }],
      to: [{ x: 4, y: 20 }, { x: 5, y: 20 }, { x: 4, y: 21 }, { x: 5, y: 21 }],
      piece: "O",
      distance: 19,
    });
    expect(lock).toEqual({
      type: "lock",
      cells: [{ x: 4, y: 20 }, { x: 5, y: 20 }, { x: 4, y: 21 }, { x: 5, y: 21 }],
      piece: "O",
    });
    expect(hardDrop.from).not.toBe(hardDrop.to);
    expect(hardDrop.from[0]).not.toBe(hardDrop.to[0]);

    hardDrop.from[0]!.x = 99;
    hardDrop.to[0]!.y = 99;
    lock.cells[0]!.x = 99;
    expect(game.board[20][4]).toBe("O");
    expect(game.board[20][5]).toBe("O");
    expect(game.board[21][4]).toBe("O");
    expect(game.board[21][5]).toBe("O");
  });

  it("reports pre-compaction clear rows, pre-clear points, level-ups, and combo resets", () => {
    const game = createGame(56);
    game.board = emptyBoard();
    game.lines = 9;
    game.level = 1;
    for (const row of [20, 21]) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (x !== 4 && x !== 5) game.board[row][x] = "T";
      }
    }
    setActive(game, "O", 3, 20);
    const events: GameEvent[] = [];
    expect(applyAction(game, "hardDrop", (event) => events.push(event))).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["hardDrop", "lock", "clear", "levelUp"]);
    const clear = events[2] as Extract<GameEvent, { type: "clear" }>;
    expect(clear).toEqual({ type: "clear", rows: [20, 21], count: 2, points: 300, combo: 1 });
    expect(game.level).toBe(2);
    expect(game.combo).toBe(1);
    clear.rows[0] = 99;
    expect(game.board[20]).toEqual(Array<null>(WIDTH).fill(null));

    game.board = emptyBoard();
    setActive(game, "O", 3, 18);
    expect(applyAction(game, "hardDrop", (event) => events.push(event))).toBe(true);
    expect(game.combo).toBe(0);

    game.board = emptyBoard();
    for (const row of [20, 21]) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (x !== 4 && x !== 5) game.board[row][x] = "Z";
      }
    }
    setActive(game, "O", 3, 20);
    expect(applyAction(game, "hardDrop", (event) => events.push(event))).toBe(true);
    const clears = events.filter((event): event is Extract<GameEvent, { type: "clear" }> => event.type === "clear");
    expect(clears.map((event) => event.combo)).toEqual([1, 1]);
  });

  it("scores a boundary-crossing clear at the pre-clear level", () => {
    const game = createGame(6);
    game.lines = 9;
    game.level = 1;
    game.board = emptyBoard();
    for (let x = 0; x < WIDTH; x += 1) {
      if (x < 3 || x > 6) game.board[21][x] = "S";
    }
    setActive(game, "I", 3, 20);
    expect(applyAction(game, "hardDrop")).toBe(true);
    expect(game.score).toBe(100);
    expect(game.lines).toBe(10);
    expect(game.level).toBe(2);

    game.board = emptyBoard();
    for (let x = 0; x < WIDTH; x += 1) {
      if (x < 3 || x > 6) game.board[21][x] = "Z";
    }
    setActive(game, "I", 3, 20);
    expect(applyAction(game, "hardDrop")).toBe(true);
    expect(game.score).toBe(300);
    expect(game.lines).toBe(11);
    expect(game.level).toBe(2);
  });

  it("limits grounded lock-delay resets to fifteen successful moves", () => {
    const game = createGame(7);
    setActive(game, "O", 3, 20);
    for (let reset = 0; reset < 15; reset += 1) {
      expect(applyAction(game, reset % 2 === 0 ? "right" : "left")).toBe(true);
    }
    expect(game.lockResets).toBe(15);
    game.lockElapsed = 450;
    expect(applyAction(game, "left")).toBe(true);
    expect(game.lockElapsed).toBe(450);
    expect(advance(game, 49)).toBe(false);
    expect(game.piecesPlaced).toBe(0);
    expect(advance(game, 1)).toBe(true);
    expect(game.piecesPlaced).toBe(1);
  });

  it("locks after floor kicks cannot keep a piece airborne forever", () => {
    const game = createGame(70);
    setActive(game, "T", 3, 19);
    for (let cycle = 0; cycle < 40 && game.piecesPlaced === 0; cycle += 1) {
      advance(game, 1000);
      if (game.piecesPlaced > 0) break;
      expect(applyAction(game, "clockwise")).toBe(true);
      expect(applyAction(game, "counterclockwise")).toBe(true);
      expect(applyAction(game, "right")).toBe(true);
    }
    expect(game.piecesPlaced).toBe(1);
  });

  it("expires the lock timer during a floor kick without hard-drop scoring", () => {
    const game = createGame(71);
    setActive(game, "T", 3, 20);
    expect(applyAction(game, "clockwise")).toBe(true);
    expect(applyAction(game, "counterclockwise")).toBe(true);
    game.lockResets = 15;
    game.lockElapsed = 450;
    expect(advance(game, 49)).toBe(false);
    expect(game.piecesPlaced).toBe(0);
    expect(advance(game, 1)).toBe(true);
    expect(game.piecesPlaced).toBe(1);
    expect(game.board[21][2]).toBe("T");
    expect(game.score).toBe(0);
  });

  it("tops out when hold cannot spawn and after a hidden-row lock clear", () => {
    const blockedSpawn = createGame(8);
    setActive(blockedSpawn, "O", 3, HEIGHT);
    blockedSpawn.held = "I";
    blockedSpawn.board[2][3] = "T";
    expect(applyAction(blockedSpawn, "hold")).toBe(true);
    expect(blockedSpawn.status).toBe("over");
    expect(blockedSpawn.active).toBeNull();
    expect(applyAction(blockedSpawn, "left")).toBe(false);

    const hiddenLock = createGame(9);
    hiddenLock.board = emptyBoard();
    for (let x = 0; x < WIDTH; x += 1) {
      if (x !== 4 && x !== 5) hiddenLock.board[1][x] = "Z";
    }
    hiddenLock.board[2][4] = "J";
    hiddenLock.board[2][5] = "J";
    setActive(hiddenLock, "O", 3, 0);
    expect(getGhostY(hiddenLock)).toBe(0);
    expect(applyAction(hiddenLock, "hardDrop")).toBe(true);
    expect(hiddenLock.lines).toBe(1);
    expect(hiddenLock.board[1][4]).toBe("O");
    expect(hiddenLock.board[1][5]).toBe("O");
    expect(hiddenLock.status).toBe("over");
    expect(hiddenLock.active).toBeNull();
  });

  it("emits terminal events once for hold and lock top-outs", () => {
    const blockedSpawn = createGame(8);
    setActive(blockedSpawn, "O", 3, HEIGHT);
    blockedSpawn.held = "I";
    blockedSpawn.board[2][3] = "T";
    const holdEvents: GameEvent[] = [];
    expect(applyAction(blockedSpawn, "hold", (event) => holdEvents.push(event))).toBe(true);
    expect(blockedSpawn.status).toBe("over");
    expect(holdEvents.map((event) => event.type)).toEqual(["hold", "gameOver"]);
    expect(applyAction(blockedSpawn, "left", (event) => holdEvents.push(event))).toBe(false);
    expect(holdEvents.filter((event) => event.type === "gameOver")).toHaveLength(1);

    const hiddenLock = createGame(9);
    hiddenLock.board = emptyBoard();
    for (let x = 0; x < WIDTH; x += 1) {
      if (x !== 4 && x !== 5) hiddenLock.board[1][x] = "Z";
    }
    hiddenLock.board[2][4] = "J";
    hiddenLock.board[2][5] = "J";
    setActive(hiddenLock, "O", 3, 0);
    expect(getGhostY(hiddenLock)).toBe(0);
    const lockEvents: GameEvent[] = [];
    expect(applyAction(hiddenLock, "hardDrop", (event) => lockEvents.push(event))).toBe(true);
    expect(hiddenLock.lines).toBe(1);
    expect(hiddenLock.status).toBe("over");
    expect(lockEvents.map((event) => event.type)).toEqual(["hardDrop", "lock", "clear", "gameOver"]);
    expect(lockEvents.filter((event) => event.type === "gameOver")).toHaveLength(1);
    expect(advance(hiddenLock, 1000, (event) => lockEvents.push(event))).toBe(false);
    expect(lockEvents.filter((event) => event.type === "gameOver")).toHaveLength(1);
  });

  it("uses the level gravity curve and rejects inputs after game over", () => {
    expect(gravityInterval(1)).toBe(1000);
    expect(gravityInterval(2)).toBe(800);
    expect(gravityInterval(100)).toBe(60);
    const game = createGame(10);
    game.status = "over";
    expect(advance(game, 1000)).toBe(false);
    expect(applyAction(game, "hardDrop")).toBe(false);
  });

  it("advances by the level gravity interval", () => {
    const game = createGame(13);
    const initialY = game.active!.y;
    expect(advance(game, 999)).toBe(false);
    expect(game.active?.y).toBe(initialY);
    expect(advance(game, 1)).toBe(true);
    expect(game.active?.y).toBe(initialY + 1);
  });
});
