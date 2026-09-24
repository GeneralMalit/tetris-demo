"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GameController, type HeldAction } from "@/src/controller/gameController";
import type { GameAction, GameEvent, GameState } from "@/src/game/contracts";
import { saveGame } from "@/src/game/engine";
import { MultiplayerClient, type ConnectionState } from "@/src/multiplayer/client";
import type { BoardSnapshot, MatchPhase, RoomView, ServerMessage } from "@/src/multiplayer/protocol";
import { renderBoard } from "@/src/render/canvasRenderer";
import MultiplayerView from "./MultiplayerView";

const SESSION_KEY = "tetris-multiplayer-session";
const NAME_KEY = "tetris-player-name";
const API_BASE = process.env.NEXT_PUBLIC_MULTIPLAYER_API_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://tetris-multiplayer.generalmalit07.workers.dev");

interface StoredSession {
  code: string;
  name: string;
  token: string;
  matchId: number;
  sequence: number;
  game?: unknown;
}

function readSession(): StoredSession | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Partial<StoredSession>;
    if (typeof data.code !== "string" || !/^[A-Z2-9]{8}$/.test(data.code) ||
      typeof data.name !== "string" || !data.name.trim() ||
      typeof data.token !== "string" || !/^[0-9a-f-]{36}$/i.test(data.token)) return null;
    return { code: data.code, name: data.name, token: data.token,
      matchId: Number.isSafeInteger(data.matchId) ? data.matchId! : 0,
      sequence: Number.isSafeInteger(data.sequence) ? data.sequence! : 0,
      game: data.game };
  } catch {
    return null;
  }
}

export interface MultiplayerSessionProps {
  onExit: () => void;
  onPhase: (phase: MatchPhase) => void;
  onGesture: () => void;
  onGameEvent: (event: GameEvent) => void;
  musicVolume: number;
  soundVolume: number;
  onMusicVolumeChange: (value: number) => void;
  onSoundVolumeChange: (value: number) => void;
}

export default function MultiplayerSession({
  onExit, onPhase, onGesture, onGameEvent,
  musicVolume, soundVolume, onMusicVolumeChange, onSoundVolumeChange,
}: MultiplayerSessionProps) {
  const boardRef = useRef<HTMLCanvasElement>(null);
  const opponentRef = useRef<HTMLCanvasElement>(null);
  const playfieldRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const clientRef = useRef<MultiplayerClient | null>(null);
  const roomRef = useRef<RoomView | null>(null);
  const storedRef = useRef<StoredSession | null>(null);
  const activeMatchRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const onPhaseRef = useRef(onPhase);
  const onGameEventRef = useRef(onGameEvent);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [opponent, setOpponent] = useState<BoardSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");

  onPhaseRef.current = onPhase;
  onGameEventRef.current = onGameEvent;

  useEffect(() => {
    const controller = new GameController();
    controller.setMultiplayerMode(true);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((next) => setGame(next ? { ...next } : null));
    const unsubscribeEvents = controller.subscribeEvents((event) => {
      onGameEventRef.current(event);
      const current = roomRef.current;
      if (!current || current.phase !== "playing" || activeMatchRef.current !== current.matchId) return;
      if (event.type === "clear") {
        clientRef.current?.send({ type: "clear", matchId: current.matchId,
          placement: controller.getState()?.piecesPlaced ?? 0, count: event.count });
      } else if (event.type === "gameOver") {
        clientRef.current?.send({ type: "topout", matchId: current.matchId });
      }
    });

    const initialCode = new URL(window.location.href).searchParams.get("room")?.trim().toUpperCase() ?? "";
    if (/^[A-Z2-9]{8}$/.test(initialCode)) setRoomCode(initialCode);
    try { setName(localStorage.getItem(NAME_KEY) ?? ""); } catch { /* Private browsing. */ }
    const saved = readSession();
    storedRef.current = saved;
    if (saved) {
      setName(saved.name);
      if (!initialCode || initialCode === saved.code) setRoomCode(saved.code);
    }

    if (API_BASE) {
      const client = new MultiplayerClient(API_BASE, {
        onMessage: (message: ServerMessage) => {
          if (message.type === "error") {
            if (message.message === "INVALID_CREDENTIALS" || message.message === "SESSION_EXPIRED") {
              storedRef.current = null;
              try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage is optional. */ }
            }
            return;
          }
          if (message.type === "board") {
            if (message.seat !== roomRef.current?.you) setOpponent(message.snapshot);
            return;
          }
          if (message.type === "garbage") {
            if (message.matchId === activeMatchRef.current && roomRef.current?.phase === "playing") {
              controller.receiveGarbage(message.holes);
            }
            return;
          }
          const next = message.room;
          const previous = roomRef.current;
          roomRef.current = next;
          setRoom(next);
          if (next.phase !== previous?.phase) {
            setError(null);
            onPhaseRef.current(next.phase);
          }
          if (next.phase === "countdown" && next.matchId !== previous?.matchId) {
            controller.pause();
            setGame(null);
            setOpponent(null);
            activeMatchRef.current = null;
            sequenceRef.current = 0;
            if (storedRef.current) {
              storedRef.current.matchId = next.matchId;
              storedRef.current.sequence = 0;
              delete storedRef.current.game;
            }
          }
          if (next.phase === "playing" && activeMatchRef.current !== next.matchId && next.seed !== null) {
            const savedGame = storedRef.current?.matchId === next.matchId ? storedRef.current.game : undefined;
            const restored = savedGame !== undefined && controller.restore(savedGame);
            activeMatchRef.current = next.matchId;
            if (savedGame !== undefined && !restored) {
              setError("Your saved board could not be restored. This round is forfeited.");
              client.send({ type: "topout", matchId: next.matchId });
              return;
            }
            if (!restored) controller.start(next.seed);
            sequenceRef.current = restored ? storedRef.current?.sequence ?? 0 : 0;
          }
          if (next.phase === "finished" && previous?.phase !== "finished") controller.pause();
        },
        onConnection: (state) => {
          setConnection(state);
          if (state === "connected") setError(null);
        },
        onError: setError,
      });
      clientRef.current = client;
      if (saved && (!initialCode || initialCode === saved.code)) {
        client.connect(saved.code, saved.name, saved.token);
      }
    }

    const snapshotTimer = window.setInterval(() => {
      const current = roomRef.current;
      const state = controller.getState();
      const savedRoom = storedRef.current;
      if (!current || current.phase !== "playing" || !state || !savedRoom ||
        activeMatchRef.current !== current.matchId) return;
      const snapshot: BoardSnapshot = {
        board: state.board, active: state.active, held: state.held, queue: state.queue,
        score: state.score, lines: state.lines, level: state.level, piecesPlaced: state.piecesPlaced,
      };
      clientRef.current?.send({ type: "board", matchId: current.matchId,
        sequence: ++sequenceRef.current, snapshot });
      savedRoom.matchId = current.matchId;
      savedRoom.sequence = sequenceRef.current;
      savedRoom.game = saveGame(state);
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(savedRoom)); } catch { /* Storage is optional. */ }
    }, 250);

    return () => {
      window.clearInterval(snapshotTimer);
      clientRef.current?.close();
      clientRef.current = null;
      unsubscribe();
      unsubscribeEvents();
      controller.dispose();
      controllerRef.current = null;
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = playfieldRef.current;
    if (element) controllerRef.current?.attach(element);
  }, [room?.phase]);

  useEffect(() => {
    const localCanvas = boardRef.current;
    const remoteCanvas = opponentRef.current;
    if (localCanvas) renderBoard(localCanvas, game);
    if (remoteCanvas) renderBoard(remoteCanvas, opponent);
  }, [game, opponent, room?.phase]);

  useEffect(() => {
    const localCanvas = boardRef.current;
    const remoteCanvas = opponentRef.current;
    const redraw = () => {
      if (localCanvas) renderBoard(localCanvas, controllerRef.current?.getState() ?? null);
      if (remoteCanvas) renderBoard(remoteCanvas, opponent);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    if (localCanvas) observer?.observe(localCanvas);
    if (remoteCanvas) observer?.observe(remoteCanvas);
    window.addEventListener("resize", redraw);
    return () => { observer?.disconnect(); window.removeEventListener("resize", redraw); };
  }, [room?.phase, opponent]);

  const joinRoom = useCallback((code: string, playerName: string) => {
    const normalized = playerName.trim();
    if (!normalized || normalized.length > 20) {
      setError("Enter a name of 1–20 characters.");
      return;
    }
    if (!/^[A-Z2-9]{8}$/.test(code)) {
      setError("Enter an 8-character room code.");
      return;
    }
    const token = crypto.randomUUID();
    const session: StoredSession = { code, name: normalized, token, matchId: 0, sequence: 0 };
    storedRef.current = session;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(NAME_KEY, normalized);
    } catch { /* In-memory identity remains valid until refresh. */ }
    setError(null);
    setRoomCode(code);
    clientRef.current?.connect(code, normalized, token);
  }, []);

  const create = useCallback(async () => {
    const normalized = name.trim();
    if (!normalized || normalized.length > 20) {
      setError("Enter a name of 1–20 characters.");
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    onGesture();
    setConnection("connecting");
    try {
      const code = await client.createRoom();
      if (clientRef.current !== client) return;
      joinRoom(code, normalized);
    } catch (cause) {
      if (clientRef.current !== client) return;
      setConnection("disconnected");
      setError(cause instanceof Error ? cause.message : "Could not create a room.");
    }
  }, [name, joinRoom, onGesture]);

  const join = useCallback(() => {
    onGesture();
    joinRoom(roomCode.trim().toUpperCase(), name);
  }, [joinRoom, roomCode, name, onGesture]);
  const ready = useCallback((value: boolean) => {
    onGesture();
    clientRef.current?.send({ type: "ready", ready: value });
  }, [onGesture]);
  const leave = useCallback(() => {
    clientRef.current?.send({ type: "leave" });
    clientRef.current?.close();
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* No stored session. */ }
    storedRef.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState(null, "", url);
    onExit();
  }, [onExit]);
  const action = useCallback((value: GameAction) => controllerRef.current?.dispatch(value), []);
  const press = useCallback((value: HeldAction) => controllerRef.current?.press(value), []);
  const release = useCallback((value: HeldAction) => controllerRef.current?.release(value), []);

  return <MultiplayerView
    room={room} opponent={opponent} local={game} connection={connection} error={error}
    name={name} roomCode={roomCode} apiAvailable={Boolean(API_BASE)}
    onNameChange={setName} onRoomCodeChange={setRoomCode} onCreate={create} onJoin={join}
    onReady={ready} onLeave={leave} boardRef={boardRef} opponentRef={opponentRef}
    playfieldRef={playfieldRef} onAction={action} onPress={press} onRelease={release}
    musicVolume={musicVolume} soundVolume={soundVolume}
    onMusicVolumeChange={onMusicVolumeChange} onSoundVolumeChange={onSoundVolumeChange}
  />;
}
