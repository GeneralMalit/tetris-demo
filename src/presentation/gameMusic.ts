import type { GameStatus } from "@/src/game/contracts";

const MENU_TRACK = "/music/bamm-pt-10-by-vhiiula-feat-maxx.mp3";
const GAME_TRACK = "/music/world-beat-journey8bit.mp3";
const TRACK_VOLUME = 0.35;
const COUNTDOWN_FADE_MS = 3_000;

/** Two looping tracks; browser playback is never attempted before a user gesture. */
export class GameMusic {
  private readonly menu = new Audio(MENU_TRACK);
  private readonly game = new Audio(GAME_TRACK);
  private volume = 0;
  private unlocked = false;
  private disposed = false;
  private status: GameStatus | null | "countdown" = null;
  private countdownStartedAt: number | null = null;
  private fadeFrame: number | null = null;

  constructor() {
    for (const track of [this.menu, this.game]) {
      track.loop = true;
      track.preload = "none";
      track.volume = 0;
    }
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.round(volume))) : 0;
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
    this.volume = 0;
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

    if (this.volume === 0 || !this.unlocked) {
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
    const volume = TRACK_VOLUME * this.volume / 100;
    this.menu.volume = playing ? 0 : volume;
    this.game.volume = playing ? volume : 0;
  }

  private applyCountdownVolumes(now: number): number {
    const elapsed = Math.max(0, now - (this.countdownStartedAt ?? now));
    const progress = Math.min(elapsed / COUNTDOWN_FADE_MS, 1);
    const volume = TRACK_VOLUME * this.volume / 100;
    this.menu.volume = volume * (1 - progress);
    this.game.volume = volume * progress;
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
    if (this.disposed || this.volume === 0 || !this.unlocked || this.status !== "countdown") return;

    if (this.applyCountdownVolumes(now) >= 1) {
      this.menu.pause();
      return;
    }
    this.startFade();
  };
}
