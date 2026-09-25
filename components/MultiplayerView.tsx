"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { GameAction, GameState, PieceType } from "@/src/game/contracts";
import type { HeldAction } from "@/src/controller/gameController";
import type { BoardSnapshot, PlayerSummary, RoomView, Seat } from "@/src/multiplayer/protocol";
import type { ConnectionState } from "@/src/multiplayer/client";
import AudioControls from "./AudioControls";
import { previewShapes, type PreviewShape } from "@/src/presentation/piecePreview";
import styles from "./MultiplayerView.module.css";

export interface MultiplayerViewProps {
  room: RoomView | null;
  opponent: BoardSnapshot | null;
  local: GameState | null;
  connection: ConnectionState;
  error: string | null;
  name: string;
  roomCode: string;
  apiAvailable: boolean;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onReady: (ready: boolean) => void;
  onLeave: () => void;
  boardRef: RefObject<HTMLCanvasElement | null>;
  opponentRef: RefObject<HTMLCanvasElement | null>;
  playfieldRef: RefObject<HTMLDivElement | null>;
  onAction: (action: GameAction) => void;
  onPress: (action: HeldAction) => void;
  onRelease: (action: HeldAction) => void;
  musicVolume: number;
  soundVolume: number;
  onMusicVolumeChange: (value: number) => void;
  onSoundVolumeChange: (value: number) => void;
}

const numberFormat = new Intl.NumberFormat("en-US");

function formatNumber(value: number) {
  return numberFormat.format(value);
}

function getSeatName(player: PlayerSummary | null, fallback: string) {
  return player?.name || fallback;
}


function connectionMessage(connection: ConnectionState) {
  switch (connection) {
    case "connected": return "";
    case "connecting": return "Connecting to the room…";
    case "reconnecting": return "Connection interrupted. Reconnecting to your seat…";
    case "disconnected": return "Connection lost. Your seat is being held briefly for a reconnect.";
  }
}

function makeInviteUrl(code: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  return copied;
}

function TouchControls({
  onAction,
  onPress,
  onRelease,
}: Pick<MultiplayerViewProps, "onAction" | "onPress" | "onRelease">) {
  const activePointers = useRef(new Map<number, HeldAction>());

  const beginHold = (action: HeldAction) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || activePointers.current.has(event.pointerId)) return;
    event.preventDefault();
    activePointers.current.set(event.pointerId, action);
    event.currentTarget.setPointerCapture(event.pointerId);
    onPress(action);
  };

  const endHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const action = activePointers.current.get(event.pointerId);
    if (!action) return;
    activePointers.current.delete(event.pointerId);
    onRelease(action);
  };

  return (
    <section className={styles.touchControls} aria-label="Touch game controls">
      <p className={styles.touchLabel}>Touch controls</p>
      <div className={styles.controlGrid}>
        <button className={styles.controlButton} type="button" aria-label="Move left" onPointerDown={beginHold("left")} onPointerUp={endHold} onPointerCancel={endHold} onLostPointerCapture={endHold}>
          <span aria-hidden="true">←</span><small>LEFT</small>
        </button>
        <button className={styles.controlButton} type="button" aria-label="Rotate counterclockwise" onClick={() => onAction("counterclockwise")}>
          <span aria-hidden="true">↶</span><small>TURN</small>
        </button>
        <button className={`${styles.controlButton} ${styles.dropButton}`} type="button" aria-label="Soft drop" onPointerDown={beginHold("softDrop")} onPointerUp={endHold} onPointerCancel={endHold} onLostPointerCapture={endHold}>
          <span aria-hidden="true">↓</span><small>DOWN</small>
        </button>
        <button className={styles.controlButton} type="button" aria-label="Rotate clockwise" onClick={() => onAction("clockwise")}>
          <span aria-hidden="true">↷</span><small>TURN</small>
        </button>
        <button className={styles.controlButton} type="button" aria-label="Move right" onPointerDown={beginHold("right")} onPointerUp={endHold} onPointerCancel={endHold} onLostPointerCapture={endHold}>
          <span aria-hidden="true">→</span><small>RIGHT</small>
        </button>
        <button className={`${styles.controlButton} ${styles.holdAction}`} type="button" aria-label="Hold piece" onClick={() => onAction("hold")}>
          <span aria-hidden="true">◇</span><small>HOLD</small>
        </button>
        <button className={`${styles.controlButton} ${styles.hardDropAction}`} type="button" aria-label="Hard drop" onClick={() => onAction("hardDrop")}>
          <span aria-hidden="true">⇊</span><small>DROP</small>
        </button>
      </div>
    </section>
  );
}

export default function MultiplayerView({
  room,
  opponent,
  local,
  connection,
  error,
  name,
  roomCode,
  apiAvailable,
  onNameChange,
  onRoomCodeChange,
  onCreate,
  onJoin,
  onReady,
  onLeave,
  boardRef,
  opponentRef,
  playfieldRef,
  onAction,
  onPress,
  onRelease,
  musicVolume,
  soundVolume,
  onMusicVolumeChange,
  onSoundVolumeChange,
}: MultiplayerViewProps) {
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteNotice, setInviteNotice] = useState("");
  const [clockAnchor, setClockAnchor] = useState(() => {
    const localNow = Date.now();
    return { serverNow: room?.serverNow ?? 0, localNow };
  });
  const [clockNow, setClockNow] = useState(clockAnchor.localNow);

  useEffect(() => {
    if (!room || room.startsAt === null) return;
    const localNow = Date.now();
    setClockAnchor({ serverNow: room.serverNow, localNow });
    setClockNow(localNow);
  }, [room?.serverNow, room?.startsAt]);

  useEffect(() => {
    if (room?.phase !== "countdown") return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [room?.phase]);

  const copyInvite = async () => {
    if (!room) return;
    const link = makeInviteUrl(room.code);
    setInviteUrl(link);
    try {
      const copied = await copyText(link);
      setInviteNotice(copied ? "Invite link copied." : "Copy unavailable. Select the invite link below to share it.");
    } catch {
      setInviteNotice("Copy unavailable. Select the invite link below to share it.");
    }
  };

  const shareInvite = async () => {
    if (!room) return;
    const link = makeInviteUrl(room.code);
    setInviteUrl(link);
    if (navigator.share) {
      try {
        await navigator.share({ title: "Tetris head-to-head", text: `Join ${getSeatName(room.players[room.you], "your friend")}'s Tetris room.`, url: link });
        setInviteNotice("Invite shared.");
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }
    try {
      const copied = await copyText(link);
      setInviteNotice(copied ? "Invite link copied." : "Select the invite link below to share it.");
    } catch {
      setInviteNotice("Select the invite link below to share it.");
    }
  };

  const waitingToJoin = !room;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <button className={styles.brand} type="button" onClick={onLeave} aria-label="Return to Tetris menu">
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /><i /></span>
          <span><strong>BLOCK PARTY</strong><small>HEAD-TO-HEAD</small></span>
        </button>
        <div className={styles.headerActions}>
          <AudioControls
            musicVolume={musicVolume}
            soundVolume={soundVolume}
            onMusicVolumeChange={onMusicVolumeChange}
            onSoundVolumeChange={onSoundVolumeChange}
          />
          {room && <button className={styles.exitButton} type="button" onClick={onLeave}>Leave room</button>}
        </div>
      </header>

      {error && <p className={styles.errorBanner} role="alert">{error}</p>}

      {waitingToJoin ? (
        <section className={styles.setup} aria-labelledby="setup-title">
          <div className={styles.introCopy}>
            <p className={styles.eyebrow}>TWO STACKS. ONE WINNER.</p>
            <h1 id="setup-title">Find your<br /><span>rival.</span></h1>
            <p>Make a room and send your friend the invite, or enter their room code to jump in.</p>
          </div>
          {!apiAvailable && (
            <div className={styles.apiWarning} role="alert">
              <span className={styles.warningIcon} aria-hidden="true">!</span>
              <div><strong>Multiplayer is not configured</strong><p>The room service URL is missing. Set up the multiplayer API before creating or joining a real match.</p></div>
            </div>
          )}
          <form className={styles.setupCard} onSubmit={(event) => { event.preventDefault(); if (apiAvailable && name.trim()) onCreate(); }}>
            <div className={styles.cardHeading}><span className={styles.stepNumber}>01</span><div><h2>Create a room</h2><p>Host a private head-to-head match.</p></div></div>
            <label className={styles.fieldLabel} htmlFor="player-name">Your name</label>
            <input id="player-name" className={styles.textInput} type="text" autoComplete="nickname" maxLength={20} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Name on the scoreboard" />
            <button className={`${styles.primaryButton} ${styles.fullButton}`} type="submit" disabled={!apiAvailable || !name.trim()}>
              Create room <span aria-hidden="true">↗</span>
            </button>
          </form>
          <form className={`${styles.setupCard} ${styles.joinCard}`} onSubmit={(event) => { event.preventDefault(); if (apiAvailable && name.trim() && roomCode.trim()) onJoin(); }}>
            <div className={styles.cardHeading}><span className={styles.stepNumber}>02</span><div><h2>Join a room</h2><p>Enter the code your friend shared.</p></div></div>
            <label className={styles.fieldLabel} htmlFor="join-name">Your name</label>
            <input id="join-name" className={styles.textInput} type="text" autoComplete="nickname" maxLength={20} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Name on the scoreboard" />
            <label className={styles.fieldLabel} htmlFor="room-code">Room code</label>
            <input id="room-code" className={`${styles.textInput} ${styles.codeInput}`} type="text" autoCapitalize="characters" autoComplete="off" maxLength={8} value={roomCode} onChange={(event) => onRoomCodeChange(event.target.value.toUpperCase())} placeholder="e.g. AB2C3D4E" />
            <button className={`${styles.secondaryButton} ${styles.fullButton}`} type="submit" disabled={!apiAvailable || !name.trim() || !roomCode.trim()}>
              Join match <span aria-hidden="true">→</span>
            </button>
          </form>
          <p className={styles.setupFootnote}><span aria-hidden="true">✦</span> Same seed, same bag. Skill decides the winner.</p>
        </section>
      ) : (
        <RoomScreen
          room={room}
          opponent={opponent}
          local={local}
          connection={connection}
          name={name}
          boardRef={boardRef}
          opponentRef={opponentRef}
          playfieldRef={playfieldRef}
          clockAnchor={clockAnchor}
          clockNow={clockNow}
          onReady={onReady}
          onLeave={onLeave}
          onAction={onAction}
          onPress={onPress}
          onRelease={onRelease}
          copyInvite={copyInvite}
          shareInvite={shareInvite}
          inviteUrl={inviteUrl}
          inviteNotice={inviteNotice}
        />
      )}
    </main>
  );
}

function RoomScreen({
  room,
  opponent,
  local,
  connection,
  name,
  boardRef,
  opponentRef,
  playfieldRef,
  clockAnchor,
  clockNow,
  onReady,
  onLeave,
  onAction,
  onPress,
  onRelease,
  copyInvite,
  shareInvite,
  inviteUrl,
  inviteNotice,
}: {
  room: RoomView;
  opponent: BoardSnapshot | null;
  local: GameState | null;
  connection: ConnectionState;
  name: string;
  boardRef: RefObject<HTMLCanvasElement | null>;
  opponentRef: RefObject<HTMLCanvasElement | null>;
  playfieldRef: RefObject<HTMLDivElement | null>;
  clockAnchor: { serverNow: number; localNow: number };
  clockNow: number;
  onReady: (ready: boolean) => void;
  onLeave: () => void;
  onAction: (action: GameAction) => void;
  onPress: (action: HeldAction) => void;
  onRelease: (action: HeldAction) => void;
  copyInvite: () => Promise<void>;
  shareInvite: () => Promise<void>;
  inviteUrl: string;
  inviteNotice: string;
}) {
  const opponentSeat: Seat = room.you === "host" ? "guest" : "host";
  const you = room.players[room.you];
  const rival = room.players[opponentSeat];
  const isReady = you?.ready ?? false;
  const bothPlayersConnected = Boolean(you?.connected && rival?.connected);
  const estimatedServerNow = clockAnchor.serverNow === room.serverNow
    ? clockAnchor.serverNow + Math.max(0, clockNow - clockAnchor.localNow)
    : room.serverNow;
  const secondsLeft = room.startsAt === null ? null : Math.max(0, Math.ceil((room.startsAt - estimatedServerNow) / 1000));
  const isCountdown = room.phase === "countdown";
  const canPlay = room.phase === "playing" && local?.status === "playing";
  const localName = getSeatName(you, name.trim() || "You");
  const rivalName = getSeatName(rival, "Waiting for player");
  const localPending = room.pending[room.you] ?? 0;
  const rivalPending = room.pending[opponentSeat] ?? 0;

  let resultTitle = "Match ended";
  if (room.winner === room.you) resultTitle = "You win!";
  else if (room.winner === opponentSeat) resultTitle = `${rivalName} wins`;

  const finishVerb = room.finishReason === "topout" ? "topped out" : room.finishReason === "disconnect" ? "disconnected" : room.finishReason === "left" ? "left the match" : "ended";
  const resultDetail = room.finishReason
    ? `${room.winner === room.you ? rival?.name ?? "Your opponent" : localName} ${finishVerb}.`
    : "The match is complete.";
  const [dismissedResultId, setDismissedResultId] = useState<number | null>(null);
  const resultDialogRef = useRef<HTMLDialogElement>(null);
  const showResultDialog = room.phase === "finished" && dismissedResultId !== room.matchId;
  useEffect(() => {
    const dialog = resultDialogRef.current;
    if (showResultDialog && dialog && !dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
  }, [showResultDialog]);


  return (
    <section className={styles.room} aria-label={`Room ${room.code}`}>
      <div className={styles.roomTopline}>
        <div>
          <p className={styles.eyebrow}>{room.phase === "waiting" ? "ROOM LOBBY" : room.phase === "finished" ? "FINAL RESULTS" : "HEAD-TO-HEAD"}</p>
          <h1 className={styles.roomHeading}>{room.phase === "waiting" ? "Ready when you are." : room.phase === "finished" ? resultTitle : "The face-off."}</h1>
        </div>
      </div>
      {room.phase !== "waiting" && room.phase !== "finished" && rival && !rival.connected && (
        <p className={styles.connectionNotice} role="status">{rivalName} lost connection. Their seat is held briefly while they reconnect.</p>
      )}

      {connection !== "connected" && <p className={styles.connectionNotice} role="status">{connectionMessage(connection)}</p>}

      <div className={styles.roomBar}>
        <div className={styles.roomCodeBlock}><span>ROOM CODE</span><strong>{room.code}</strong></div>
        <div className={styles.inviteActions}>
          <button className={styles.inviteButton} type="button" onClick={() => void copyInvite()}><span aria-hidden="true">▣</span> Copy invite</button>
          <button className={styles.shareButton} type="button" onClick={() => void shareInvite()}><span aria-hidden="true">↗</span><span className={styles.shareLabel}>Share</span></button>
        </div>
        {inviteNotice && <p className={styles.inviteNotice} role="status" aria-live="polite">{inviteNotice}</p>}
        {inviteUrl && <p className={styles.inviteLinkLine}><span>Invite link</span><a href={inviteUrl}>{inviteUrl}</a></p>}
      </div>

      {room.phase === "waiting" && (
        <section className={styles.lobby} aria-labelledby="lobby-title">
          <div className={styles.lobbyHeading}><div><p className={styles.eyebrow}>PLAYERS</p><h2 id="lobby-title">The lobby</h2></div><span className={styles.playerCount}>{rival ? "2 / 2 PLAYERS" : "1 / 2 PLAYERS"}</span></div>
          <div className={styles.playerList}>
            <PlayerRow player={you} name={localName} seat={room.you} isYou />
            <PlayerRow player={rival} name={rivalName} seat={opponentSeat} isYou={false} />
          </div>
          <div className={styles.lobbyFooter}>
            <p>{rival ? (bothPlayersConnected ? "Both players are here. Ready up to start." : "Waiting for both players to connect…") : "Share your invite link. Your match starts when both players are ready."}</p>
            <button className={styles.primaryButton} type="button" disabled={!bothPlayersConnected || connection !== "connected"} onClick={() => onReady(!isReady)}>
              {isReady ? "Cancel ready" : "Ready up"}<span aria-hidden="true">{isReady ? "↻" : "→"}</span>
            </button>
          </div>
        </section>
      )}

      {isCountdown && (
        <section className={styles.countdownPanel} aria-label="Synchronized match countdown">
          <p className={styles.eyebrow}>SYNCHRONIZED START</p>
          <div className={styles.countdownNumber} aria-live="assertive" aria-atomic="true">{secondsLeft === null ? "…" : secondsLeft === 0 ? "GO" : secondsLeft}</div>
          <p>Both boards are seeded the same. Get ready to stack.</p>
        </section>
      )}

      {(room.phase === "playing" || room.phase === "finished") && (
        <>
          {room.phase === "finished" && (
            <section className={styles.resultPanel} aria-labelledby="result-title">
              <div><p className={styles.eyebrow}>MATCH COMPLETE</p><h2 id="result-title">{resultTitle}</h2><p>{resultDetail}</p></div>
              <div className={styles.rematchActions}>
                <button className={styles.primaryButton} type="button" disabled={connection !== "connected"} onClick={() => onReady(!isReady)}>
                  {isReady ? "Ready for rematch" : "Play again"}<span aria-hidden="true">{isReady ? "✓" : "↻"}</span>
                </button>
                <p>{isReady ? "Waiting for your rival to ready up." : rival?.ready ? `${rivalName} is ready for a rematch.` : "Ready up when you want another round."}</p>
              </div>
            </section>
          )}

          <div className={styles.battleBoards} aria-label="Match boards">
            <PlayerBoard
              name={localName}
              seat={room.you}
              you
              canvasRef={boardRef}
              playfieldRef={playfieldRef}
              score={local?.score ?? you?.score ?? 0}
              lines={local?.lines ?? you?.lines ?? 0}
              held={local?.held ?? null}
              queue={local?.queue ?? []}
              pending={localPending}
              snapshotAvailable={Boolean(local)}
              liveLabel={room.phase === "finished" ? "FINAL" : "LIVE"}
            />
            <PlayerBoard
              name={rivalName}
              seat={opponentSeat}
              you={false}
              canvasRef={opponentRef}
              playfieldRef={undefined}
              score={opponent?.score ?? rival?.score ?? 0}
              lines={opponent?.lines ?? rival?.lines ?? 0}
              held={opponent?.held ?? null}
              queue={opponent?.queue ?? []}
              pending={rivalPending}
              snapshotAvailable={Boolean(opponent)}
              liveLabel={room.phase === "finished" ? "FINAL" : "RIVAL"}
            />
          </div>

          {canPlay && (
            <>
              <TouchControls onAction={onAction} onPress={onPress} onRelease={onRelease} />
              <details className={styles.keyboardHelp}>
                <summary>Keyboard controls <span aria-hidden="true">⌄</span></summary>
                <p><kbd>←</kbd> <kbd>→</kbd> move <span>·</span> <kbd>↓</kbd> soft drop <span>·</span> <kbd>↑</kbd> / <kbd>X</kbd> rotate <span>·</span> <kbd>Z</kbd> counter-rotate <span>·</span> <kbd>Space</kbd> hard drop <span>·</span> <kbd>C</kbd> hold</p>
              </details>
            </>
          )}
          {room.phase === "playing" && local?.status !== "playing" && <p className={styles.waitingStatus} role="status">Waiting for the room to finish this round…</p>}
        </>
      )}
      {showResultDialog && (
        <dialog
          ref={resultDialogRef}
          className={styles.resultDialog}
          tabIndex={-1}
          aria-labelledby="final-result-dialog-title"
          aria-describedby="final-result-dialog-message"
          onCancel={() => setDismissedResultId(room.matchId)}
        >
          <p className={styles.resultDialogOutcome}>{resultTitle}</p>
          <h2 id="final-result-dialog-title">GAME OVER</h2>
          <p className={styles.resultDialogMessage} id="final-result-dialog-message">{resultDetail}</p>
          <button className={styles.primaryButton} type="button" onClick={onLeave}>
            Back to menu <span aria-hidden="true">→</span>
          </button>
        </dialog>
      )}
    </section>
  );
}


function PlayerRow({ player, name, seat, isYou }: { player: PlayerSummary | null; name: string; seat: Seat; isYou: boolean }) {
  return (
    <article className={`${styles.playerRow} ${isYou ? styles.playerRowYou : ""}`}>
      <div className={styles.playerAvatar} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || (isYou ? "Y" : "?")}</div>
      <div className={styles.playerIdentity}><strong>{name}</strong><span>{isYou ? "You" : "Opponent"} · {seat}</span></div>
      <div className={`${styles.readyState} ${player?.ready ? styles.isReady : ""}`}>
        <span aria-hidden="true">{player?.connected ? (player.ready ? "✓" : "●") : "○"}</span>
        {player?.connected ? (player.ready ? "Ready" : "Connected") : "Waiting"}
      </div>
    </article>
  );
}

function PlayerBoard({
  name,
  seat,
  you,
  canvasRef,
  playfieldRef,
  score,
  lines,
  held,
  queue,
  pending,
  snapshotAvailable,
  liveLabel,
}: {
  name: string;
  seat: Seat;
  you: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  playfieldRef: RefObject<HTMLDivElement | null> | undefined;
  score: number;
  lines: number;
  held: PieceType | null;
  queue: readonly PieceType[];
  pending: number;
  snapshotAvailable: boolean;
  liveLabel: string;
}) {
  return (
    <article className={`${styles.playerBoard} ${you ? styles.localBoard : styles.opponentBoard}`} aria-label={`${name}${you ? ", your board" : ", opponent board"}`}>
      <div className={styles.boardHeader}>
        <div className={styles.boardPlayer}><span className={styles.seatTag}>{seat}</span><h2>{name}{you && <span className={styles.youTag}>YOU</span>}</h2></div>
        <span className={styles.boardLive}><span aria-hidden="true" />{liveLabel}</span>
      </div>
      <dl className={styles.boardStats}>
        <div><dt>Score</dt><dd>{formatNumber(score)}</dd></div>
        <div><dt>Lines</dt><dd>{formatNumber(lines)}</dd></div>
        <div className={pending > 0 ? styles.incomingAttack : ""}><dt>Incoming</dt><dd>{formatNumber(pending)}<span> lines</span></dd></div>
      </dl>
      <div className={styles.boardLayout}>
        <aside className={styles.holdPreview} aria-label={`${name}'s held piece`}>
          <span className={styles.previewTitle}>Hold</span>
          <PiecePreview type={held} label="Held piece" loading={!snapshotAvailable} />
        </aside>
        <div className={styles.boardCenter}>
          <div
            className={styles.boardViewport}
            ref={playfieldRef}
            tabIndex={you ? 0 : undefined}
            role={you ? "group" : "img"}
            aria-label={you ? `${name}'s Tetris playfield. Keyboard controls are available while playing.` : `${name}'s live opponent board, read only.`}
          >
            <canvas ref={canvasRef} className={styles.boardCanvas} aria-label={`${name}'s Tetris board`} />
            {!snapshotAvailable && <div className={styles.boardPlaceholder} aria-hidden="true">{you ? "BOARD STARTING" : "WAITING FOR BOARD"}</div>}
          </div>
          <p className={styles.boardCaption}>{you ? "Your stack" : "Opponent · read only"}</p>
        </div>
        <aside className={styles.nextPreview} aria-label={`${name}'s next five pieces`}>
          <span className={styles.previewTitle}>Next</span>
          <ol className={styles.nextList} aria-label="Next five pieces">
            {Array.from({ length: 5 }, (_, index) => (
              <li key={index}>
                <PiecePreview
                  type={queue[index] ?? null}
                  label={`Next piece ${index + 1}`}
                  loading={!snapshotAvailable}
                />
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </article>
  );
}

function PiecePreview({ type, label, loading }: { type: PieceType | null; label: string; loading: boolean }) {
  const shape: PreviewShape | null = type ? previewShapes[type] : null;
  return (
    <span
      className={styles.previewGrid}
      role="img"
      aria-label={type ? `${label}: ${type} piece` : `${label}: ${loading ? "waiting for board" : "empty"}`}
    >
      {shape ? (
        <span
          className={styles.previewShape}
          style={{
            gridTemplateColumns: `repeat(${shape.columns}, var(--preview-cell))`,
            gridTemplateRows: `repeat(${shape.rows}, var(--preview-cell))`,
          }}
          aria-hidden="true"
        >
          {shape.cells.map(([x, y], index) => (
            <span
              className={styles.previewCell}
              data-piece={type}
              style={{ gridColumn: x + 1, gridRow: y + 1 }}
              key={index}
            />
          ))}
        </span>
      ) : (
        <span className={styles.previewEmpty} aria-hidden="true">{loading ? "Waiting" : "Empty"}</span>
      )}
    </span>
  );
}
