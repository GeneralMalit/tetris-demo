import type { GameEvent } from "@/src/game/contracts";

type Tone = { frequency: number; at: number };
type ToneShape = {
  tones: readonly Tone[];
  duration: number;
  volume: number;
  wave: OscillatorType;
  pitchFall?: number;
};

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

const MAX_SIMULTANEOUS_TONES = 5;
const MOVE_INTERVAL_SECONDS = 0.055;
const ROTATE_INTERVAL_SECONDS = 0.075;

/** Small synthesized cabinet sounds; construction is inert until a user gesture unlocks audio. */
export class ArcadeAudio {
  private context: AudioContext | null = null;
  private readonly voices = new Map<OscillatorNode, GainNode>();
  private enabled = false;
  private lastMoveAt = Number.NEGATIVE_INFINITY;
  private lastRotateAt = Number.NEGATIVE_INFINITY;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.unlock();
    } else {
      this.stopVoices();
      this.suspend();
    }
  }

  /** Call only from a start/resume/toggle user gesture. */
  unlock(): void {
    if (typeof window === "undefined") return;
    try {
      if (!this.context) {
        const AudioContextConstructor =
          window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
        if (!AudioContextConstructor) return;
        this.context = new AudioContextConstructor();
      }
      if (this.context.state !== "running") {
        void this.context.resume().catch(() => undefined);
      }
    } catch {
      // Audio is an optional enhancement; unsupported or blocked contexts are harmless.
    }
  }

  play(event: GameEvent): void {
    if (!this.enabled) return;
    const context = this.context;
    if (!context || context.state !== "running") return;

    const now = context.currentTime;
    let shape: ToneShape | null = null;
    switch (event.type) {
      case "move":
        if (now - this.lastMoveAt < MOVE_INTERVAL_SECONDS) return;
        this.lastMoveAt = now;
        shape = { tones: [{ frequency: 250, at: 0 }], duration: 0.035, volume: 0.025, wave: "square" };
        break;
      case "rotate":
        if (now - this.lastRotateAt < ROTATE_INTERVAL_SECONDS) return;
        this.lastRotateAt = now;
        shape = { tones: [{ frequency: 620, at: 0 }], duration: 0.055, volume: 0.045, wave: "triangle" };
        break;
      case "hardDrop":
        shape = {
          tones: [{ frequency: 105, at: 0 }],
          duration: 0.15,
          volume: 0.16,
          wave: "sine",
          pitchFall: 48,
        };
        break;
      case "lock":
        shape = { tones: [{ frequency: 175, at: 0 }], duration: 0.065, volume: 0.075, wave: "triangle" };
        break;
      case "clear": {
        const intensity = Math.max(1, Math.min(4, event.count));
        shape = {
          tones: [
            { frequency: 440, at: 0 },
            { frequency: 570 + intensity * 35, at: 0.09 },
            { frequency: 740 + intensity * 55, at: 0.19 },
          ],
          duration: 0.34 + intensity * 0.035,
          volume: 0.07 + intensity * 0.012,
          wave: "sine",
        };
        break;
      }
      case "levelUp":
        shape = {
          tones: [
            { frequency: 587, at: 0 },
            { frequency: 740, at: 0.11 },
            { frequency: 932, at: 0.22 },
          ],
          duration: 0.44,
          volume: 0.09,
          wave: "triangle",
        };
        break;
      case "gameOver":
        return;
    }
    if (shape) this.playShape(context, now, shape);
  }

  /** Stop sounds without racing an asynchronous suspend against a same-gesture restart. */
  pause(): void {
    this.stopVoices();
  }

  dispose(): void {
    this.enabled = false;
    this.stopVoices();
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  private playShape(context: AudioContext, now: number, shape: ToneShape): void {
    if (this.voices.size >= MAX_SIMULTANEOUS_TONES) {
      const oldest = this.voices.keys().next().value;
      if (oldest) this.stopVoice(oldest);
    }

    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const endAt = now + shape.duration;
      oscillator.type = shape.wave;
      for (const tone of shape.tones) oscillator.frequency.setValueAtTime(tone.frequency, now + tone.at);
      if (shape.pitchFall) {
        oscillator.frequency.setValueAtTime(shape.tones[0].frequency, now);
        oscillator.frequency.exponentialRampToValueAtTime(shape.pitchFall, endAt);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(shape.volume, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      this.voices.set(oscillator, gain);
      oscillator.onended = () => {
        this.voices.delete(oscillator);
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          // Already-disconnected nodes need no further cleanup.
        }
      };
      oscillator.start(now);
      oscillator.stop(endAt + 0.01);
    } catch {
      // A suspended or resource-constrained browser may reject an optional tone.
    }
  }

  private stopVoice(voice: OscillatorNode): void {
    const gain = this.voices.get(voice);
    this.voices.delete(voice);
    voice.onended = null;
    try {
      voice.stop();
    } catch {
      // The voice may have ended between the stop check and call.
    }
    try {
      voice.disconnect();
      gain?.disconnect();
    } catch {
      // Already-disconnected nodes need no further cleanup.
    }
  }

  private stopVoices(): void {
    for (const voice of [...this.voices.keys()]) this.stopVoice(voice);
  }

  private suspend(): void {
    const context = this.context;
    if (context && context.state === "running") {
      void context.suspend().catch(() => undefined);
    }
  }
}
