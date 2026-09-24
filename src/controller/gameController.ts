import { advance, applyAction, applyGarbage, createGame, restoreGame } from "../game/engine";
import type { GameAction, GameEvent, GameState, GameStatus } from "../game/contracts";

export type HeldAction = "left" | "right" | "softDrop";

export interface GameScheduler {
  now(): number;
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(handle: number): void;
}

interface HeldControl {
  order: number;
  nextRepeatAt: number;
}

type KeyBinding = GameAction | "pause";

const STEP_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 5;
const DAS_MS = 150;
const ARR_MS = 50;
const HORIZONTAL_ACTIONS = ["left", "right"] as const;
const EDITABLE_OR_BUTTON =
  "input, textarea, select, button, [role='button'], [contenteditable]:not([contenteditable='false'])";

const KEY_BINDINGS: Record<string, KeyBinding> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "softDrop",
  ArrowUp: "clockwise",
  KeyX: "clockwise",
  x: "clockwise",
  X: "clockwise",
  KeyZ: "counterclockwise",
  z: "counterclockwise",
  Z: "counterclockwise",
  Space: "hardDrop",
  " ": "hardDrop",
  KeyC: "hold",
  c: "hold",
  C: "hold",
  KeyP: "pause",
  p: "pause",
  P: "pause",
  Escape: "pause",
};

function createBrowserScheduler(): GameScheduler {
  return {
    now: () => globalThis.performance.now(),
    requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
    cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle),
  };
}

function createRandomSeed(): number {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("A cryptographically secure random source is required to start a game.");
  }
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function asElement(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  return target as Element;
}

function isEditableOrButton(element: Element | null): boolean {
  return Boolean(element?.closest(EDITABLE_OR_BUTTON));
}

export class GameController {
  private readonly scheduler: GameScheduler;
  private game: GameState | null = null;
  private readonly subscribers = new Set<(state: GameState | null) => void>();
  private readonly eventSubscribers = new Set<(event: GameEvent) => void>();
  private readonly pointerHeld = new Set<HeldAction>();
  private readonly keyboardHeld = new Map<string, HeldAction>();
  private readonly handledKeys = new Set<string>();
  private readonly heldControls = new Map<HeldAction, HeldControl>();
  private attachedElement: HTMLElement | null = null;
  private attachedDocument: Document | null = null;
  private attachedWindow: Window | null = null;
  private frameHandle: number | null = null;
  private frameToken = 0;
  private lastFrameTimestamp: number | null = null;
  private accumulator = 0;
  private simulationTime = 0;
  private nextPressOrder = 0;
  private multiplayerMode = false;
  private disposed = false;
  private readonly forwardEvent = (event: GameEvent): void => {
    for (const subscriber of [...this.eventSubscribers]) {
      if (this.eventSubscribers.has(subscriber)) subscriber(event);
    }
  };

  constructor(scheduler?: GameScheduler) {
    this.scheduler = scheduler ?? createBrowserScheduler();
  }

  getState(): GameState | null {
    return this.game;
  }

  subscribe(listener: (state: GameState | null) => void): () => void {
    if (this.disposed) {
      listener(null);
      return () => undefined;
    }
    this.subscribers.add(listener);
    listener(this.game);
    return () => this.subscribers.delete(listener);
  }

  subscribeEvents(listener: (event: GameEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.eventSubscribers.add(listener);
    return () => this.eventSubscribers.delete(listener);
  }

  start(seed?: number): void {
    if (this.disposed) return;
    this.cancelFrameLoop();
    this.clearHeldInputs(false);
    this.simulationTime = 0;
    this.lastFrameTimestamp = this.scheduler.now();
    this.game = createGame(seed ?? createRandomSeed());
    this.notify();
    this.scheduleFrame();
  }

  restore(saved: unknown): boolean {
    if (this.disposed) return false;
    const game = restoreGame(saved);
    if (!game) return false;
    this.cancelFrameLoop();
    this.clearHeldInputs(false);
    this.game = game;
    this.simulationTime = 0;
    this.lastFrameTimestamp = this.scheduler.now();
    this.notify();
    this.scheduleFrame();
    return true;
  }

  receiveGarbage(holes: readonly number[]): boolean {
    const game = this.game;
    if (this.disposed || !game) return false;
    const changed = applyGarbage(
      game,
      holes,
      this.eventSubscribers.size > 0 ? this.forwardEvent : undefined,
    );
    if (!changed) return false;
    if (game.status !== "playing") {
      this.clearHeldInputs(true);
      this.cancelFrameLoop();
    }
    this.notify();
    return true;
  }

  setMultiplayerMode(enabled: boolean): void {
    this.multiplayerMode = enabled;
  }

  pause(): void {
    if (this.game?.status !== "playing") return;
    this.game.status = "paused";
    this.clearHeldInputs(true);
    this.cancelFrameLoop();
    this.notify();
  }

  resume(): void {
    if (this.disposed || this.game?.status !== "paused") return;
    this.game.status = "playing";
    this.accumulator = 0;
    this.lastFrameTimestamp = this.scheduler.now();
    this.notify();
    this.scheduleFrame();
  }

  dispatch(action: GameAction): void {
    if (this.disposed || this.game?.status !== "playing") return;
    this.apply(action);
  }

  press(action: HeldAction): void {
    if (this.disposed || this.game?.status !== "playing" || this.pointerHeld.has(action)) return;
    const wasHeld = this.isHeld(action);
    this.pointerHeld.add(action);
    if (!wasHeld) this.beginHold(action);
  }

  release(action: HeldAction): void {
    if (!this.pointerHeld.delete(action)) return;
    if (!this.isHeld(action)) this.heldControls.delete(action);
  }

  attach(element: HTMLElement): void {
    if (this.disposed || this.attachedElement === element) return;
    this.detach();
    this.clearHeldInputs(false);

    this.attachedElement = element;
    const document = element.ownerDocument;
    const window = document?.defaultView ?? null;
    this.attachedDocument = document ?? null;
    this.attachedWindow = window;

    element.addEventListener("focusout", this.onFocusOut);
    window?.addEventListener("keydown", this.onKeyDown, true);
    window?.addEventListener("keyup", this.onKeyUp, true);
    window?.addEventListener("blur", this.onWindowBlur);
    document?.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrameLoop();
    this.clearHeldInputs(false);
    this.detach();
    this.game = null;
    this.subscribers.clear();
    this.eventSubscribers.clear();
  }

  private scheduleFrame(): void {
    if (this.disposed || this.frameHandle !== null || this.game?.status !== "playing") return;
    const token = this.frameToken;
    this.frameHandle = this.scheduler.requestFrame((timestamp) => this.onFrame(token, timestamp));
  }

  private cancelFrameLoop(): void {
    this.frameToken += 1;
    if (this.frameHandle !== null) {
      this.scheduler.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.lastFrameTimestamp = null;
    this.accumulator = 0;
  }

  private onFrame(token: number, timestamp: number): void {
    if (this.disposed || token !== this.frameToken) return;
    this.frameHandle = null;
    const game = this.game;
    if (!game || game.status !== "playing") return;

    const previous = this.lastFrameTimestamp ?? timestamp;
    this.lastFrameTimestamp = timestamp;
    const elapsed = Number.isFinite(timestamp - previous) ? Math.max(0, timestamp - previous) : 0;
    this.accumulator += elapsed;

    let ticks = 0;
    let changed = false;
    while (this.accumulator + 1e-9 >= STEP_MS && ticks < MAX_CATCH_UP_STEPS) {
      this.accumulator = Math.max(0, this.accumulator - STEP_MS);
      this.simulationTime += STEP_MS;
      ticks += 1;

      changed = this.repeatHeldActions() || changed;
      if (game.status !== "playing") break;

      const status: GameStatus = game.status;
      changed = advance(
        game,
        STEP_MS,
        this.eventSubscribers.size > 0 ? this.forwardEvent : undefined,
      ) || changed;
      if (status !== game.status) changed = true;
      if (game.status !== "playing") {
        this.clearHeldInputs(true);
        break;
      }
    }

    if (ticks === MAX_CATCH_UP_STEPS) this.accumulator = 0;
    if (changed) this.notify();

    if (token === this.frameToken && game.status === "playing") this.scheduleFrame();
  }

  private apply(action: GameAction, notify = true): boolean {
    const game = this.game;
    if (!game || game.status !== "playing") return false;
    const status = game.status;
    const changed = applyAction(
      game,
      action,
      this.eventSubscribers.size > 0 ? this.forwardEvent : undefined,
    ) || status !== game.status;
    if (game.status !== "playing") {
      this.clearHeldInputs(true);
      this.cancelFrameLoop();
    }
    if (changed && notify) this.notify();
    return changed;
  }

  private beginHold(action: HeldAction): void {
    this.heldControls.set(action, {
      order: ++this.nextPressOrder,
      nextRepeatAt: this.simulationTime + (action === "softDrop" ? ARR_MS : DAS_MS),
    });
    this.apply(action);
  }

  private isHeld(action: HeldAction): boolean {
    if (this.pointerHeld.has(action)) return true;
    for (const held of this.keyboardHeld.values()) {
      if (held === action) return true;
    }
    return false;
  }

  private repeatHeldActions(): boolean {
    let changed = false;
    let direction: HeldAction | null = null;
    let latestOrder = -1;
    for (const action of HORIZONTAL_ACTIONS) {
      const control = this.heldControls.get(action);
      if (control && control.order > latestOrder) {
        direction = action;
        latestOrder = control.order;
      }
    }

    if (direction) {
      const control = this.heldControls.get(direction)!;
      if (this.simulationTime >= control.nextRepeatAt - 0.001) {
        changed = this.apply(direction, false) || changed;
        control.nextRepeatAt += ARR_MS;
      }
    }

    const softDrop = this.heldControls.get("softDrop");
    if (softDrop && this.simulationTime >= softDrop.nextRepeatAt - 0.001) {
      changed = this.apply("softDrop", false) || changed;
      softDrop.nextRepeatAt += ARR_MS;
    }
    return changed;
  }

  private handleKeyUp(key: string): boolean {
    const wasHandled = this.handledKeys.delete(key);
    const action = this.keyboardHeld.get(key);
    if (action) {
      this.keyboardHeld.delete(key);
      if (!this.isHeld(action)) this.heldControls.delete(action);
    }
    return wasHandled;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const binding = KEY_BINDINGS[event.code] ?? KEY_BINDINGS[event.key];
    if (!binding || !this.ownsFocus(event.target)) return;
    if (binding === "pause" && this.multiplayerMode) return;

    const game = this.game;
    if (!game || (game.status !== "playing" && !(game.status === "paused" && binding === "pause"))) return;

    const key = event.code || event.key;
    if (this.handledKeys.has(key) || event.repeat) {
      event.preventDefault();
      return;
    }

    this.handledKeys.add(key);
    if (binding === "pause") {
      if (game.status === "playing") this.pause();
      else this.resume();
    } else if (binding === "left" || binding === "right" || binding === "softDrop") {
      const wasHeld = this.isHeld(binding);
      this.keyboardHeld.set(key, binding);
      if (!wasHeld) this.beginHold(binding);
    } else {
      this.apply(binding);
    }
    event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.code || event.key;
    const wasHandled = this.handleKeyUp(key);
    const binding = KEY_BINDINGS[event.code] ?? KEY_BINDINGS[event.key];
    if (
      wasHandled &&
      binding &&
      this.game?.status === "playing" &&
      this.ownsFocus(event.target)
    ) {
      event.preventDefault();
    }
  };

  private ownsFocus(eventTarget: EventTarget | null): boolean {
    const element = this.attachedElement;
    const document = this.attachedDocument;
    const active = document?.activeElement ?? null;
    if (!element || !document || !active) return false;
    if (this.isIgnoredFocus(eventTarget) || isEditableOrButton(active)) return false;
    return (
      active === element ||
      element.contains(active) ||
      active === document.body ||
      active === document.documentElement
    );
  }

  private isIgnoredFocus(eventTarget: EventTarget | null): boolean {
    return isEditableOrButton(asElement(eventTarget));
  }

  private onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (
      next &&
      this.attachedElement?.contains(next as Node) &&
      !isEditableOrButton(asElement(next))
    ) {
      return;
    }
    this.clearHeldInputs(false);
  };

  private onWindowBlur = (): void => {
    this.clearHeldInputs(false);
    if (!this.multiplayerMode) this.pause();
  };

  private onVisibilityChange = (): void => {
    if (this.attachedDocument?.visibilityState === "hidden") {
      this.clearHeldInputs(false);
      if (!this.multiplayerMode) this.pause();
    }
  };

  private clearHeldInputs(preserveHandledKeys: boolean): void {
    this.pointerHeld.clear();
    this.keyboardHeld.clear();
    this.heldControls.clear();
    if (!preserveHandledKeys) this.handledKeys.clear();
  }

  private detach(): void {
    this.attachedElement?.removeEventListener("focusout", this.onFocusOut);
    this.attachedWindow?.removeEventListener("keydown", this.onKeyDown, true);
    this.attachedWindow?.removeEventListener("keyup", this.onKeyUp, true);
    this.attachedWindow?.removeEventListener("blur", this.onWindowBlur);
    this.attachedDocument?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.attachedElement = null;
    this.attachedDocument = null;
    this.attachedWindow = null;
  }

  private notify(): void {
    for (const subscriber of [...this.subscribers]) {
      if (this.subscribers.has(subscriber)) subscriber(this.game);
    }
  }
}
