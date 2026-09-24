"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameEvent, GameState } from "@/src/game/contracts";
import type { MatchPhase } from "@/src/multiplayer/protocol";
import { GameController } from "@/src/controller/gameController";
import { ArcadeEffects } from "@/src/render/arcadeEffects";
import { ArcadeAudio } from "@/src/presentation/arcadeAudio";
import { GameMusic } from "@/src/presentation/gameMusic";
import type { ArcadeFeedback } from "@/src/presentation/contracts";
import { renderBoard } from "@/src/render/canvasRenderer";
import GameView from "./GameView";
import MultiplayerSession from "./MultiplayerSession";

const BEST_SCORE_KEY = "tetris-best-score";
const SOUND_ENABLED_KEY = "tetris-sound-enabled";
const MUSIC_VOLUME_KEY = "tetris-music-volume";
const SFX_VOLUME_KEY = "tetris-sfx-volume";
const FEEDBACK_DURATION_MS: Record<ArcadeFeedback["kind"], number> = {
  drop: 180,
  lock: 130,
  hold: 220,
  clear: 800,
  levelUp: 800,
};
const FEEDBACK_PRIORITY: Record<ArcadeFeedback["kind"], number> = {
  drop: 2,
  lock: 1,
  clear: 4,
  hold: 2,
  levelUp: 5,
};
const CLEAR_LABELS: Record<number, string> = {
  1: "SINGLE",
  2: "DOUBLE",
  3: "TRIPLE",
  4: "TETRIS!",
};

type ActiveFeedback = { value: ArcadeFeedback; expiresAt: number };

function validScore(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function parseVolume(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed <= 100 ? parsed : null;
}

function feedbackForEvent(event: GameEvent, id: number): ArcadeFeedback | null {
  switch (event.type) {
    case "hardDrop":
      return { id, kind: "drop", label: "", points: event.distance * 2, combo: 0 };
    case "lock":
      return { id, kind: "lock", label: "", points: 0, combo: 0 };
    case "hold":
      return { id, kind: "hold", label: "", points: 0, combo: 0 };
    case "clear":
      return {
        id,
        kind: "clear",
        label: CLEAR_LABELS[event.count] ?? "TETRIS!",
        points: event.points,
        combo: event.combo,
      };
    case "levelUp":
      return { id, kind: "levelUp", label: `LEVEL ${event.level}`, points: 0, combo: 0 };
    case "move":
    case "rotate":
    case "gameOver":
      return null;
  }
}

function clockNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export default function GameSession() {
  const boardRef = useRef<HTMLCanvasElement>(null);
  const playfieldRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const effectsRef = useRef<ArcadeEffects | null>(null);
  const audioRef = useRef<ArcadeAudio | null>(null);
  const musicRef = useRef<GameMusic | null>(null);
  const effectFrameRef = useRef<number | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFeedbackRef = useRef<ActiveFeedback | null>(null);
  const feedbackIdRef = useRef(0);
  const bestScoreRef = useRef(0);
  const runStartBestRef = useRef(0);
  const musicVolumeRef = useRef(0);
  const soundVolumeRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const canvasUnavailableRef = useRef(false);
  const [game, setGame] = useState<GameState | null>(null);
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const [bestScore, setBestScore] = useState(0);
  const [musicVolume, setMusicVolume] = useState(0);
  const [soundVolume, setSoundVolume] = useState(0);
  const [feedback, setFeedback] = useState<ArcadeFeedback | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [screen, setScreen] = useState<"menu" | "countdown" | "game" | "multiplayer">("menu");
  const [countdown, setCountdown] = useState<3 | 2 | 1 | null>(null);

  reducedMotionRef.current = reducedMotion;

  const clearPresentation = useCallback(() => {
    effectsRef.current?.clear();
    if (effectFrameRef.current !== null) {
      cancelAnimationFrame(effectFrameRef.current);
      effectFrameRef.current = null;
    }
    if (feedbackTimeoutRef.current !== null) {
      clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
    activeFeedbackRef.current = null;
    setFeedback(null);
    audioRef.current?.pause();
  }, []);

  useEffect(() => {
    const controller = new GameController();
    const effects = new ArcadeEffects();
    const audio = new ArcadeAudio();
    const music = new GameMusic();
    controllerRef.current = controller;
    effectsRef.current = effects;
    audioRef.current = audio;
    musicRef.current = music;

    try {
      const storedBest = window.localStorage.getItem(BEST_SCORE_KEY);
      if (storedBest !== null) {
        const parsedBest = Number(storedBest);
        if (validScore(parsedBest)) {
          bestScoreRef.current = parsedBest;
          runStartBestRef.current = parsedBest;
          setBestScore(parsedBest);
        }
      }
    } catch {
      // Storage may be unavailable (for example, in a private browsing context).
    }
    let storedMusicVolume = 0;
    let storedSfxVolume = 0;
    try {
      const savedMusic = window.localStorage.getItem(MUSIC_VOLUME_KEY);
      const savedSfx = window.localStorage.getItem(SFX_VOLUME_KEY);
      const legacySound = window.localStorage.getItem(SOUND_ENABLED_KEY);
      const legacyVolume = legacySound === "true" ? 100 : 0;
      storedMusicVolume = savedMusic === null ? legacyVolume : parseVolume(savedMusic) ?? 0;
      storedSfxVolume = savedSfx === null ? legacyVolume : parseVolume(savedSfx) ?? 0;
      if (savedMusic === null) window.localStorage.setItem(MUSIC_VOLUME_KEY, String(storedMusicVolume));
      if (savedSfx === null) window.localStorage.setItem(SFX_VOLUME_KEY, String(storedSfxVolume));
    } catch {
      // Audio preferences remain usable for this session if storage is unavailable.
    }
    musicVolumeRef.current = storedMusicVolume;
    soundVolumeRef.current = storedSfxVolume;
    setMusicVolume(storedMusicVolume);
    setSoundVolume(storedSfxVolume);
    music.setVolume(storedMusicVolume);
    audio.setVolume(storedSfxVolume);
    const unlockAudio = () => {
      if (musicVolumeRef.current > 0) music.unlock();
      if (soundVolumeRef.current > 0) audio.unlock();
    };
    window.addEventListener("pointerdown", unlockAudio, true);
    window.addEventListener("keydown", unlockAudio, true);
    const cancelCountdown = () => {
      if (countdownTimerRef.current === null) return;
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
      setCountdown(null);
      setScreen("menu");
      music.setStatus(null);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") cancelCountdown();
    };
    window.addEventListener("blur", cancelCountdown);
    document.addEventListener("visibilitychange", onHidden);

    const draw = () => {
      const canvas = boardRef.current;
      if (!canvas) return;
      const unavailable = !renderBoard(canvas, controller.getState());
      if (unavailable !== canvasUnavailableRef.current) {
        canvasUnavailableRef.current = unavailable;
        setCanvasUnavailable(unavailable);
      }
      if (!unavailable) effects.draw(canvas, clockNow(), reducedMotionRef.current);
    };

    const animateEffects = () => {
      effectFrameRef.current = null;
      draw();
      if (effects.hasActive(clockNow())) {
        effectFrameRef.current = requestAnimationFrame(animateEffects);
      }
    };
    const scheduleEffectFrame = () => {
      if (effectFrameRef.current === null) {
        effectFrameRef.current = requestAnimationFrame(animateEffects);
      }
    };

    const publishFeedback = (event: GameEvent, now: number) => {
      const id = feedbackIdRef.current + 1;
      const next = feedbackForEvent(event, id);
      if (!next) return;
      const current = activeFeedbackRef.current;
      if (next.kind === "levelUp" && current?.value.kind === "clear" && current.expiresAt > now) {
        next.label = `${current.value.label}\n${next.label}`;
        next.points = current.value.points;
        next.combo = current.value.combo;
      }
      if (
        current &&
        current.expiresAt > now &&
        FEEDBACK_PRIORITY[next.kind] < FEEDBACK_PRIORITY[current.value.kind]
      ) {
        return;
      }
      feedbackIdRef.current = id;
      const duration = FEEDBACK_DURATION_MS[next.kind];
      const active = { value: next, expiresAt: now + duration };
      activeFeedbackRef.current = active;
      setFeedback(next);
      clearTimeout(feedbackTimeoutRef.current ?? undefined);
      feedbackTimeoutRef.current = setTimeout(() => {
        if (activeFeedbackRef.current?.value.id !== id) return;
        activeFeedbackRef.current = null;
        feedbackTimeoutRef.current = null;
        setFeedback(null);
      }, duration);
    };

    const unsubscribeEvents = controller.subscribeEvents((event) => {
      const now = clockNow();
      if (event.type === "gameOver") {
        clearPresentation();
        draw();
        return;
      }
      effects.push(event, now);
      publishFeedback(event, now);
      if (soundVolumeRef.current > 0) audio.play(event);
      if (effects.hasActive(now)) scheduleEffectFrame();
    });
    const unsubscribe = controller.subscribe((next) => {
      music.setStatus(next?.status ?? null);
      setGame(next ? { ...next } : null);
      if (next && validScore(next.score) && next.score > bestScoreRef.current) {
        bestScoreRef.current = next.score;
        setBestScore(next.score);
        try {
          window.localStorage.setItem(BEST_SCORE_KEY, String(next.score));
        } catch {
          // The in-memory record still works for this session.
        }
      }
      if (!next || next.status !== "playing") clearPresentation();
      draw();
    });

    window.addEventListener("resize", draw);
    draw();

    return () => {
      window.removeEventListener("pointerdown", unlockAudio, true);
      window.removeEventListener("keydown", unlockAudio, true);
      window.removeEventListener("blur", cancelCountdown);
      document.removeEventListener("visibilitychange", onHidden);
      if (countdownTimerRef.current !== null) {
        clearTimeout(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      window.removeEventListener("resize", draw);
      unsubscribeEvents();
      unsubscribe();
      if (effectFrameRef.current !== null) {
        cancelAnimationFrame(effectFrameRef.current);
        effectFrameRef.current = null;
      }
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
      if (feedbackTimeoutRef.current !== null) {
        clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = null;
      }
      effects.clear();
      audio.dispose();
      music.dispose();
      controller.dispose();
      controllerRef.current = null;
      effectsRef.current = null;
      audioRef.current = null;
      musicRef.current = null;
      activeFeedbackRef.current = null;
    };
  }, []);

  useEffect(() => {
    const invite = new URL(window.location.href).searchParams.get("room")?.toUpperCase() ?? "";
    if (/^[A-Z2-9]{8}$/.test(invite)) {
      setScreen("multiplayer");
      return;
    }
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem("tetris-multiplayer-session") ?? "null");
      if (saved && typeof saved === "object" && "code" in saved &&
        typeof saved.code === "string" && /^[A-Z2-9]{8}$/.test(saved.code)) {
        setScreen("multiplayer");
      }
    } catch {
      // Refresh still opens the menu if session storage is unavailable.
    }
  }, []);

  useEffect(() => {
    const canvas = boardRef.current;
    const playfield = playfieldRef.current;
    if (!canvas || !playfield) return;
    controllerRef.current?.attach(playfield);
    const draw = () => {
      const unavailable = !renderBoard(canvas, screen === "countdown" ? null : controllerRef.current?.getState() ?? null);
      if (unavailable !== canvasUnavailableRef.current) {
        canvasUnavailableRef.current = unavailable;
        setCanvasUnavailable(unavailable);
      }
      if (!unavailable) effectsRef.current?.draw(canvas, clockNow(), reducedMotionRef.current);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    observer?.observe(canvas);
    draw();
    return () => observer?.disconnect();
  }, [screen]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  const focusBoard = useCallback(() => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      playfieldRef.current?.focus({ preventScroll: true });
      if (window.matchMedia("(min-width: 681px)").matches) window.scrollTo(0, 0);
    });
  }, []);
  const selectSingleplayer = useCallback(() => {
    if (!controllerRef.current || countdownTimerRef.current !== null) return;
    clearPresentation();
    setScreen("countdown");
    setCountdown(3);
    if (soundVolumeRef.current > 0) audioRef.current?.unlock();
    musicRef.current?.restartGame();
    musicRef.current?.setStatus("countdown");
    musicRef.current?.unlock();
    const tick = (number: 3 | 2 | 1) => {
      countdownTimerRef.current = window.setTimeout(() => {
        if (document.visibilityState === "hidden") {
          countdownTimerRef.current = null;
          setCountdown(null);
          setScreen("menu");
          musicRef.current?.setStatus(null);
          return;
        }
        if (number > 1) {
          const next = (number - 1) as 2 | 1;
          setCountdown(next);
          tick(next);
          return;
        }
        countdownTimerRef.current = null;
        runStartBestRef.current = bestScoreRef.current;
        setCountdown(null);
        setScreen("game");
        controllerRef.current?.start();
        focusBoard();
      }, 1000);
    };
    tick(3);
  }, [clearPresentation, focusBoard]);
  const returnToMenu = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    clearPresentation();
    controllerRef.current?.pause();
    musicRef.current?.setStatus(null);
    setCountdown(null);
    setScreen("menu");
  }, [clearPresentation]);
  const start = useCallback(() => {
    clearPresentation();
    runStartBestRef.current = bestScoreRef.current;
    if (soundVolumeRef.current > 0) audioRef.current?.unlock();
    musicRef.current?.restartGame();
    controllerRef.current?.start();
    musicRef.current?.unlock();
    focusBoard();
  }, [clearPresentation, focusBoard]);
  const resume = useCallback(() => {
    clearPresentation();
    if (soundVolumeRef.current > 0) audioRef.current?.unlock();
    controllerRef.current?.resume();
    musicRef.current?.unlock();
    focusBoard();
  }, [clearPresentation, focusBoard]);
  const pause = useCallback(() => {
    clearPresentation();
    controllerRef.current?.pause();
  }, [clearPresentation]);
  const changeMusicVolume = useCallback((value: number) => {
    const volume = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    musicVolumeRef.current = volume;
    setMusicVolume(volume);
    musicRef.current?.setVolume(volume);
    if (volume > 0) musicRef.current?.unlock();
    try {
      window.localStorage.setItem(MUSIC_VOLUME_KEY, String(volume));
    } catch {
      // Audio remains adjustable for this session if storage is unavailable.
    }
  }, []);
  const changeSoundVolume = useCallback((value: number) => {
    const volume = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    soundVolumeRef.current = volume;
    setSoundVolume(volume);
    audioRef.current?.setVolume(volume);
    if (volume > 0) audioRef.current?.unlock();
    try {
      window.localStorage.setItem(SFX_VOLUME_KEY, String(volume));
    } catch {
      // Audio remains adjustable for this session if storage is unavailable.
    }
  }, []);

  const selectMultiplayer = useCallback(() => {
    clearPresentation();
    musicRef.current?.setStatus(null);
    setScreen("multiplayer");
  }, [clearPresentation]);
  const exitMultiplayer = useCallback(() => {
    clearPresentation();
    musicRef.current?.setStatus(null);
    setScreen("menu");
  }, [clearPresentation]);
  const multiplayerPhase = useCallback((phase: MatchPhase) => {
    if (phase === "countdown") musicRef.current?.restartGame();
    musicRef.current?.setStatus(phase === "waiting" ? null : phase === "finished" ? "over" : phase);
  }, []);
  const multiplayerGesture = useCallback(() => {
    if (soundVolumeRef.current > 0) audioRef.current?.unlock();
    if (musicVolumeRef.current > 0) musicRef.current?.unlock();
  }, []);
  const multiplayerEvent = useCallback((event: GameEvent) => {
    if (soundVolumeRef.current > 0 && event.type !== "gameOver") audioRef.current?.play(event);
  }, []);

  return (
    screen === "multiplayer" ? (
      <MultiplayerSession
        onExit={exitMultiplayer}
        onPhase={multiplayerPhase}
        onGesture={multiplayerGesture}
        onGameEvent={multiplayerEvent}
        musicVolume={musicVolume}
        soundVolume={soundVolume}
        onMusicVolumeChange={changeMusicVolume}
        onSoundVolumeChange={changeSoundVolume}
      />
    ) : (
    <GameView
      game={screen === "countdown" ? null : game}
      boardRef={boardRef}
      playfieldRef={playfieldRef}
      canvasUnavailable={canvasUnavailable}
      screen={screen}
      countdown={countdown}
      onSelectSingleplayer={selectSingleplayer}
      onSelectMultiplayer={selectMultiplayer}
      onMenu={returnToMenu}
      onRestart={start}
      onPause={pause}
      onResume={resume}
      feedback={feedback}
      bestScore={bestScore}
      newBest={Boolean(game && game.score > runStartBestRef.current)}
      musicVolume={musicVolume}
      soundVolume={soundVolume}
      onMusicVolumeChange={changeMusicVolume}
      onSoundVolumeChange={changeSoundVolume}
      reducedMotion={reducedMotion}
    />
    )
  );
}
