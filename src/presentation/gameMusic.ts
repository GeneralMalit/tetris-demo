import type { GameStatus } from "@/src/game/contracts";

const MENU_TRACK = "/music/bamm-pt-10-by-vhiiula-feat-maxx.mp3";
const GAME_TRACK = "/music/world-beat-journey8bit.mp3";
const TRACK_VOLUME = 0.35;
const COUNTDOWN_FADE_MS = 3_000;

/** Two looping tracks; browser playback is never attempted before a user gesture. */
export class GameMusic {
  private readonly menu = new Audio(MENU_TRACK);
  private readonly game = new Audio(GAME_TRACK);
  private enabled = false;
  private unlocked = false;
  private disposed = false;
  private status: GameStatus | null | "countdown" = null;
  private countdownStartedAt: number | null = null;
  private fadeFrame: number | null = null;

  constructor() {
    for (const track of [this.menu, this.game]) {
      track.loop = true;
      track.preload = "none";
      track.volume = TRACK_VOLUME;
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    this.sync();
  }

  /** Call synchronously inside a pointer or keyboard gesture. */
  unlock(): void {
    if (this.disposed) return;
    this.unlocked = true;
    this.sync();
  }

  setStatus(status: GameStatus | null | "countdown"): void {
    if (this.disposed || status === this.status) return;
    this.stopFade();
    this.status = status;
    this.countdownStartedAt = status === "countdown" ? performance.now() : null;
    this.sync();
  }

  restartGame(): void {
    this.game.pause();
    this.game.currentTime = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.stopFade();
    this.menu.pause();
    this.game.pause();
    this.menu.removeAttribute("src");
    this.game.removeAttribute("src");
    this.menu.load();
    this.game.load();
  }

  private sync(): void {
    if (this.disposed) return;

    if (!this.enabled || !this.unlocked) {
      this.stopFade();
      this.menu.pause();
      this.game.pause();
      if (this.status === "countdown") {
        this.applyCountdownVolumes(performance.now());
      } else {
        this.applySteadyVolumes();
      }
      return;
    }

    if (this.status === "paused") {
      this.stopFade();
      this.applySteadyVolumes();
      this.menu.pause();
      this.game.pause();
      return;
    }

    if (this.status === "playing") {
      this.stopFade();
      this.applySteadyVolumes();
      this.menu.pause();
      this.playIfPaused(this.game);
      return;
    }

    if (this.status === "countdown") {
      const progress = this.applyCountdownVolumes(performance.now());
      this.playIfPaused(this.game);
      if (progress < 1) {
        this.playIfPaused(this.menu);
        this.startFade();
      } else {
        this.menu.pause();
      }
      return;
    }

    this.stopFade();
    this.applySteadyVolumes();
    this.game.pause();
    this.playIfPaused(this.menu);
  }

  private applySteadyVolumes(): void {
    const playing = this.status === "playing" || this.status === "paused";
    this.menu.volume = playing ? 0 : TRACK_VOLUME;
    this.game.volume = playing ? TRACK_VOLUME : 0;
  }

  private applyCountdownVolumes(now: number): number {
    const elapsed = Math.max(0, now - (this.countdownStartedAt ?? now));
    const progress = Math.min(elapsed / COUNTDOWN_FADE_MS, 1);
    this.menu.volume = TRACK_VOLUME * (1 - progress);
    this.game.volume = TRACK_VOLUME * progress;
    return progress;
  }

  private playIfPaused(track: HTMLAudioElement): void {
    if (track.paused) void track.play().catch(() => undefined);
  }

  private startFade(): void {
    if (this.fadeFrame === null) {
      this.fadeFrame = requestAnimationFrame(this.updateFade);
    }
  }

  private stopFade(): void {
    if (this.fadeFrame === null) return;
    cancelAnimationFrame(this.fadeFrame);
    this.fadeFrame = null;
  }

  private readonly updateFade = (now: number): void => {
    this.fadeFrame = null;
    if (this.disposed || !this.enabled || !this.unlocked || this.status !== "countdown") return;

    if (this.applyCountdownVolumes(now) >= 1) {
      this.menu.pause();
      return;
    }
    this.startFade();
  };
}
