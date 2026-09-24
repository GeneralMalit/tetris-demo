import { describe, expect, it } from "vitest";
import { ROWS, WIDTH, type GameEvent, type PieceType } from "../game/contracts";
import { saveGame } from "../game/engine";
import { GameController, type GameScheduler } from "./gameController";

class FakeScheduler implements GameScheduler {
  time = 0;
  private nextHandle = 1;
  private readonly frames = new Map<number, (timestamp: number) => void>();
  private readonly canceledFrames: Array<(timestamp: number) => void> = [];

  now(): number {
    return this.time;
  }

  requestFrame(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    const callback = this.frames.get(handle);
    if (callback) this.canceledFrames.push(callback);
    this.frames.delete(handle);
  }

  frame(elapsedMs: number): void {
    this.time += elapsedMs;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(this.time);
  }

  elapseWithoutFrame(elapsedMs: number): void {
    this.time += elapsedMs;
  }

  deliverCanceledFrames(elapsedMs: number): void {
    this.time += elapsedMs;
    const callbacks = this.canceledFrames.splice(0);
    for (const callback of callbacks) callback(this.time);
  }

  get pendingFrames(): number {
    return this.frames.size;
  }
}

interface TestDocument extends EventTarget {
  activeElement: Element | null;
  defaultView: Window | null;
  visibilityState: DocumentVisibilityState;
  body: Element;
  documentElement: Element;
}

interface TestElement extends EventTarget {
  ownerDocument: Document;
  contains(node: Node): boolean;
  closest(selector: string): Element | null;
  interactive: boolean;
  children: Set<EventTarget>;
}

function createAttachedElements(): {
  document: TestDocument;
  window: EventTarget;
  playfield: TestElement;
  button: TestElement;
  siblingPlayfield: TestElement;
  body: TestElement;
} {
  const document = new EventTarget() as TestDocument;
  const window = new EventTarget();
  Object.assign(document, { activeElement: null, defaultView: window, visibilityState: "visible" });

  const createElement = (): TestElement => {
    const element = new EventTarget() as TestElement;
    Object.assign(element, {
      ownerDocument: document,
      interactive: false,
      children: new Set<EventTarget>(),
      contains(node: Node) {
        return node === (element as unknown as Node) || element.children.has(node);
      },
      closest() {
        return element.interactive ? (element as unknown as Element) : null;
      },
    });
    return element;
  };

  const playfield = createElement();
  const button = createElement();
  button.interactive = true;
  const siblingPlayfield = createElement();
  const body = createElement();
  const documentElement = createElement();
  playfield.children.add(button);
  body.children.add(playfield);
  body.children.add(siblingPlayfield);
  Object.assign(document, { body, documentElement, activeElement: playfield });

  return { document, window, playfield, button, siblingPlayfield, body };
}

function keyEvent(type: "keydown" | "keyup", code: string, key = code, repeat = false): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: key },
    repeat: { value: repeat },
  });
  return event;
}

const FRAME_MS = 1000 / 60;

describe("GameController", () => {
  it("advances the engine on a fixed 60 Hz cadence", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    controller.start(71);
    const game = controller.getState()!;
    const initialY = game.active!.y;

    for (let frame = 0; frame < 59; frame += 1) scheduler.frame(FRAME_MS);
    expect(game.active!.y).toBe(initialY);
    scheduler.frame(FRAME_MS);
    expect(game.active!.y).toBe(initialY + 1);
    controller.dispose();
  });

  it("forwards keyboard repeats and gravity lock events without replay", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(81);
    const events: GameEvent[] = [];
    const unsubscribe = controller.subscribeEvents((event) => events.push(event));
    expect(events).toEqual([]);

    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(events).toEqual([{ type: "move" }]);
    for (let frame = 0; frame < 8; frame += 1) scheduler.frame(FRAME_MS);
    expect(events).toHaveLength(1);
    scheduler.frame(FRAME_MS);
    expect(events).toEqual([{ type: "move" }, { type: "move" }]);
    dom.window.dispatchEvent(keyEvent("keyup", "ArrowLeft"));

    const game = controller.getState()!;
    game.board = Array.from({ length: ROWS }, () => Array<PieceType | null>(WIDTH).fill(null));
    game.active = { type: "O", x: 3, y: 20, rotation: 0 };
    game.gravityElapsed = 0;
    game.lockElapsed = 0;
    game.lockResets = 0;
    game.lockDelayStarted = false;
    for (let frame = 0; frame < 40; frame += 1) scheduler.frame(FRAME_MS);
    expect(events.filter((event) => event.type === "lock")).toHaveLength(1);

    unsubscribe();
    const countAfterUnsubscribe = events.length;
    controller.dispatch("right");
    expect(events).toHaveLength(countAfterUnsubscribe);
    controller.dispose();
  });

  it("pauses on window blur, clears held movement, and resumes without hidden-time catch-up", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(72);
    const game = controller.getState()!;
    const startX = game.active!.x;
    const startY = game.active!.y;

    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(game.active!.x).toBe(startX - 1);
    dom.window.dispatchEvent(new Event("blur"));
    expect(game.status).toBe("paused");
    expect(scheduler.pendingFrames).toBe(0);

    scheduler.elapseWithoutFrame(10_000);
    controller.resume();
    scheduler.frame(FRAME_MS);

    expect(game.status).toBe("playing");
    expect(game.active!.x).toBe(startX - 1);
    expect(game.active!.y).toBe(startY);

    dom.document.visibilityState = "hidden";
    dom.document.dispatchEvent(new Event("visibilitychange"));
    expect(game.status).toBe("paused");
    scheduler.elapseWithoutFrame(10_000);
    dom.document.visibilityState = "visible";
    dom.document.dispatchEvent(new Event("visibilitychange"));
    expect(game.status).toBe("paused");
    controller.resume();
    expect(game.status).toBe("playing");
    controller.dispose();
  });

  it("clears held inputs without pausing when multiplayer loses focus", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.setMultiplayerMode(true);
    controller.start(82);
    const game = controller.getState()!;
    const startX = game.active!.x;

    dom.window.dispatchEvent(keyEvent("keydown", "KeyP"));
    dom.window.dispatchEvent(keyEvent("keydown", "Escape"));
    expect(game.status).toBe("playing");
    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(game.active!.x).toBe(startX - 1);
    dom.window.dispatchEvent(new Event("blur"));
    expect(game.status).toBe("playing");
    scheduler.frame(10 * FRAME_MS);
    expect(game.active!.x).toBe(startX - 1);
    dom.window.dispatchEvent(keyEvent("keydown", "ArrowRight"));
    expect(game.active!.x).toBe(startX);

    dom.document.visibilityState = "hidden";
    dom.document.dispatchEvent(new Event("visibilitychange"));
    scheduler.frame(10 * FRAME_MS);
    expect(game.active!.x).toBe(startX);
    expect(game.status).toBe("playing");
    expect(scheduler.pendingFrames).toBe(1);
    controller.dispose();
  });

  it("restores snapshots and stops the frame loop when garbage tops out", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    controller.start(83);
    const saved = saveGame(controller.getState()!);
    const firstGame = controller.getState()!;
    firstGame.board[0][0] = "J";
    let stateUpdates = 0;
    controller.subscribe(() => { stateUpdates += 1; });
    const events: GameEvent[] = [];
    controller.subscribeEvents((event) => events.push(event));

    expect(controller.restore(saved)).toBe(true);
    const restored = controller.getState()!;
    expect(restored).not.toBe(firstGame);
    expect(restored.board[0][0]).toBeNull();
    expect(stateUpdates).toBe(2);

    restored.board[0][0] = "J";
    expect(controller.receiveGarbage([4])).toBe(true);
    expect(restored.status).toBe("over");
    expect(events).toEqual([{ type: "gameOver" }]);
    expect(scheduler.pendingFrames).toBe(0);
    expect(stateUpdates).toBe(3);
    expect(controller.receiveGarbage([4])).toBe(false);
    controller.dispose();
  });

  it("caps a delayed frame instead of simulating an unbounded catch-up", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    controller.start(73);
    const game = controller.getState()!;
    const initialY = game.active!.y;

    scheduler.frame(10_000);

    expect(game.active!.y).toBe(initialY);
    controller.dispose();
  });

  it("applies horizontal movement immediately, then repeats after DAS and at ARR", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(74);
    const game = controller.getState()!;
    const initialX = game.active!.x;

    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(game.active!.x).toBe(initialX - 1);

    for (let frame = 0; frame < 8; frame += 1) scheduler.frame(FRAME_MS);
    expect(game.active!.x).toBe(initialX - 1);
    scheduler.frame(FRAME_MS);
    expect(game.active!.x).toBe(initialX - 2);

    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft", "ArrowLeft", true));
    expect(game.active!.x).toBe(initialX - 2);
    for (let frame = 0; frame < 3; frame += 1) scheduler.frame(FRAME_MS);
    expect(game.active!.x).toBe(initialX - 3);

    dom.window.dispatchEvent(keyEvent("keyup", "ArrowLeft"));
    controller.dispose();
  });

  it("repeats pointer movement while pressed and stops after release", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    controller.start(77);
    const game = controller.getState()!;
    const initialX = game.active!.x;

    controller.press("right");
    expect(game.active!.x).toBe(initialX + 1);
    for (let frame = 0; frame < 9; frame += 1) scheduler.frame(FRAME_MS);
    expect(game.active!.x).toBe(initialX + 2);

    controller.release("right");
    for (let frame = 0; frame < 3; frame += 1) scheduler.frame(FRAME_MS);
    expect(game.active!.x).toBe(initialX + 2);
    controller.dispose();
  });

  it("ignores key input from editable or button focus and only prevents handled gameplay keys", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(75);
    const game = controller.getState()!;
    const initialX = game.active!.x;

    dom.document.activeElement = dom.button as unknown as Element;
    const ignored = keyEvent("keydown", "ArrowLeft");
    dom.window.dispatchEvent(ignored);
    expect(game.active!.x).toBe(initialX);
    expect(ignored.defaultPrevented).toBe(false);

    dom.document.activeElement = dom.playfield as unknown as Element;
    const handled = keyEvent("keydown", "ArrowLeft");
    dom.window.dispatchEvent(handled);
    expect(game.active!.x).toBe(initialX - 1);
    expect(handled.defaultPrevented).toBe(true);

    controller.dispose();
  });

  it("accepts keyboard input when the page has focus without playfield focus", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(80);
    const game = controller.getState()!;
    const initialX = game.active!.x;
    dom.document.activeElement = dom.body as unknown as Element;

    const handled = keyEvent("keydown", "ArrowLeft");
    dom.window.dispatchEvent(handled);

    expect(game.active!.x).toBe(initialX - 1);
    expect(handled.defaultPrevented).toBe(true);
    controller.dispose();
  });

  it("ignores a cancelled animation callback after a new game starts", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    controller.start(78);
    controller.start(79);
    const game = controller.getState()!;
    const initialGravity = game.gravityElapsed;

    scheduler.deliverCanceledFrames(1_000);

    expect(game.gravityElapsed).toBe(initialGravity);
    expect(scheduler.pendingFrames).toBe(1);
    controller.dispose();
  });

  it("detaches old listeners and cancels pending animation work on dispose", () => {
    const scheduler = new FakeScheduler();
    const controller = new GameController(scheduler);
    const dom = createAttachedElements();
    controller.attach(dom.playfield as unknown as HTMLElement);
    controller.start(76);
    const game = controller.getState()!;
    const initialX = game.active!.x;

    controller.attach(dom.siblingPlayfield as unknown as HTMLElement);
    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(game.active!.x).toBe(initialX);

    dom.document.activeElement = dom.siblingPlayfield as unknown as Element;
    dom.window.dispatchEvent(keyEvent("keydown", "ArrowRight"));
    expect(game.active!.x).toBe(initialX + 1);

    controller.dispose();
    expect(scheduler.pendingFrames).toBe(0);
    dom.window.dispatchEvent(keyEvent("keydown", "ArrowLeft"));
    expect(game.active!.x).toBe(initialX + 1);
    expect(controller.getState()).toBeNull();
  });
});
