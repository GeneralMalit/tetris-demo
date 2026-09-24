"use client";

import { useEffect, useRef, memo, type RefObject } from "react";
import { HIDDEN_ROWS, type GameState, type PieceType } from "@/src/game/contracts";
import type { ArcadeFeedback } from "@/src/presentation/contracts";
import styles from "./GameView.module.css";

export interface GameViewProps {
  game: GameState | null;
  boardRef: RefObject<HTMLCanvasElement | null>;
  playfieldRef: RefObject<HTMLDivElement | null>;
  canvasUnavailable: boolean;
  feedback: ArcadeFeedback | null;
  bestScore: number;
  newBest: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
  reducedMotion: boolean;
  screen: "menu" | "countdown" | "game";
  countdown: 3 | 2 | 1 | null;
  onSelectSingleplayer: () => void;
  onSelectMultiplayer: () => void;
  onMenu: () => void;
  onRestart: () => void;
  onPause: () => void;
  onResume: () => void;
}

type PreviewShape = {
  columns: number;
  rows: number;
  cells: readonly (readonly [number, number])[];
};

const previewShapes: Record<PieceType, PreviewShape> = {
  I: { columns: 4, rows: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  O: { columns: 2, rows: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { columns: 3, rows: 2, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { columns: 3, rows: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { columns: 3, rows: 2, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { columns: 3, rows: 2, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { columns: 3, rows: 2, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

const pieceClasses: Record<PieceType, string> = {
  I: styles.pieceI,
  O: styles.pieceO,
  T: styles.pieceT,
  S: styles.pieceS,
  Z: styles.pieceZ,
  J: styles.pieceJ,
  L: styles.pieceL,
};

const formatScore = (score: number) => new Intl.NumberFormat("en-US").format(score);

const PiecePreview = memo(function PiecePreview({ type, label }: { type: PieceType | null; label: string }) {
  const shape = type ? previewShapes[type] : null;
  const cellClass = type ? `${styles.previewCell} ${pieceClasses[type]}` : "";

  return (
    <div className={styles.previewGrid} role="img" aria-label={type ? `${label}: ${type} piece` : `${label}: empty`}>
      {shape && (
        <div
          className={styles.previewShape}
          aria-hidden="true"
          style={{
            gridTemplateColumns: `repeat(${shape.columns}, var(--preview-cell))`,
            gridTemplateRows: `repeat(${shape.rows}, var(--preview-cell))`,
          }}
        >
          {shape.cells.map(([x, y], index) => (
            <span className={cellClass} style={{ gridColumn: x + 1, gridRow: y + 1 }} key={index} />
          ))}
        </div>
      )}
    </div>
  );
});

function StatusPill({ game }: { game: GameState | null }) {
  const status = game?.status ?? "ready";
  const label = status === "playing" ? "In play" : status === "paused" ? "Paused" : status === "over" ? "Game over" : "Ready";
  const statusClass = status === "playing" ? styles.statusPlaying : status === "paused" ? styles.statusPaused : status === "over" ? styles.statusOver : styles.statusReady;

  return (
    <div className={`${styles.statusPill} ${statusClass}`} role="status" aria-atomic="true">
      <span className={styles.statusDot} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default function GameView({
  game,
  boardRef,
  playfieldRef,
  canvasUnavailable,
  feedback,
  bestScore,
  newBest,
  soundEnabled,
  onToggleSound,
  reducedMotion,
  screen,
  countdown,
  onSelectSingleplayer,
  onSelectMultiplayer,
  onMenu,
  onRestart,
  onPause,
  onResume,
}: GameViewProps) {
  const boardFrameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!feedback || feedback.kind !== "drop" || reducedMotion) return;

    const frame = boardFrameRef.current;
    if (
      !frame ||
      typeof frame.animate !== "function" ||
      (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) return;

    const animation = frame.animate(
      [
        { transform: "translate3d(0, 0, 0)" },
        { transform: "translate3d(0, 2px, 0)" },
        { transform: "translate3d(-1px, -1px, 0)" },
        { transform: "translate3d(1px, 0, 0)" },
        { transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 100, easing: "ease-out" },
    );

    return () => animation.cancel();
  }, [feedback?.id, feedback?.kind, reducedMotion]);

  const restartGame = () => {
    onRestart();
    playfieldRef.current?.focus({ preventScroll: true });
  };
  const resumeGame = () => {
    onResume();
    playfieldRef.current?.focus({ preventScroll: true });
  };
  const queuedPieces = Array.from({ length: 5 }, (_, index) => game?.queue[index] ?? null);
  const isPlaying = game?.status === "playing";
  const showOverlay = screen === "game" && (game?.status === "paused" || game?.status === "over");
  const linesProgress = (game?.lines ?? 0) % 10;
  const dangerous = game?.board.some((row, index) =>
    index >= HIDDEN_ROWS && index < HIDDEN_ROWS + 4 && row.some(Boolean),
  ) ?? false;
  const queueShift = (game?.piecesPlaced ?? 0) > 0;
  const scorePulse = (feedback?.points ?? 0) > 0;

  return (
    <main className={styles.page} data-reduced-motion={reducedMotion} data-screen={screen}>
      <div
        className={styles.pageContent}
        inert={screen === "countdown"}
        aria-hidden={screen === "countdown" || undefined}
      >
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandMark} aria-hidden="true"><span /><span /><span /><span /></div>
          <h1 className={styles.title}>TET<span className={styles.titleCyan}>R</span><span className={styles.titlePink}>IS</span></h1>
        </div>
        <div className={styles.headerTools}>
          <StatusPill game={screen === "menu" ? null : game} />
          <button
            className={styles.soundButton}
            type="button"
            onClick={onToggleSound}
            aria-pressed={soundEnabled}
            aria-label={soundEnabled ? "Turn sound off" : "Turn sound on"}
          >
            <span className={styles.soundGlyph} aria-hidden="true">{soundEnabled ? "♪" : "×"}</span>
            <span>Sound {soundEnabled ? "on" : "off"}</span>
          </button>
        </div>
      </header>
      {screen === "menu" ? (
        <section className={styles.modeScreen} aria-labelledby="mode-heading">
          <div className={styles.modeCard}>
            <div className={styles.modeEmblem} aria-hidden="true"><span /><span /><span /><span /></div>
            <p className={styles.modeEyebrow}>THE ARCADE IS OPEN</p>
            <h2 className={styles.modeTitle} id="mode-heading">Choose your mode</h2>
            <p className={styles.modeDescription}>Find your rhythm, stack smart, and chase a new high score.</p>
            <div className={styles.modeOptions}>
              <button className={styles.modeOption} type="button" onClick={onSelectSingleplayer}>
                <span className={styles.modeIcon} aria-hidden="true">▦</span>
                <span className={styles.modeOptionCopy}>
                  <strong>Singleplayer</strong>
                  <span>Start a classic solo run</span>
                </span>
                <span className={styles.modeArrow} aria-hidden="true">→</span>
              </button>
              <button className={styles.modeOption} type="button" onClick={onSelectMultiplayer}>
                <span className={styles.modeIcon} aria-hidden="true">◇</span>
                <span className={styles.modeOptionCopy}>
                  <strong>Multiplayer</strong>
                  <span>Play head-to-head</span>
                </span>
                <span className={styles.modeArrow} aria-hidden="true">→</span>
              </button>
            </div>
            <p className={styles.modeFootnote}>Create a room or join a friend for a head-to-head match.</p>
          </div>
        </section>
      ) : (
        <>

      <section className={styles.scoreboard} aria-label="Game statistics">
        <div className={styles.scoreCluster}>
          <dl className={styles.scoreReadout}>
            <div className={styles.scoreCurrent}>
              <dt className={styles.statLabel}>Score</dt>
              <dd
                className={`${styles.scoreValue} ${scorePulse ? styles.scorePulse : ""}`}
                key={`${game?.score ?? 0}-${scorePulse ? feedback?.id : "quiet"}`}
              >
                {formatScore(game?.score ?? 0)}
              </dd>
            </div>
            <div className={styles.bestReadout}>
              <dt className={styles.statLabel}>Best</dt>
              <dd>{formatScore(bestScore)}</dd>
              {newBest && <span className={styles.newBestTag}>NEW</span>}
            </div>
          </dl>
        </div>

        <dl className={styles.statsReadout}>
          <div className={styles.statReadout}>
            <dt className={styles.statLabel}>Level</dt>
            <dd>{game?.level ?? 1}</dd>
          </div>
          <div className={styles.statReadout}>
            <dt className={styles.statLabel}>Lines</dt>
            <dd>{game?.lines ?? 0}</dd>
          </div>
        </dl>

        <div
          className={styles.levelProgress}
          role="progressbar"
          aria-label="Lines toward next level"
          aria-valuemin={0}
          aria-valuemax={10}
          aria-valuenow={linesProgress}
          aria-valuetext={`${linesProgress} of 10 lines toward next level`}
        >
          <span style={{ width: `${linesProgress * 10}%` }} />
        </div>
      </section>

      <div className={styles.gameLayout}>
        <div className={styles.stageBar}>
          <h2 className={styles.boardTitle}>Playfield</h2>
          {isPlaying && (
            <div className={styles.playfieldActions}>
              <button className={styles.secondaryButton} type="button" onClick={onPause} aria-label="Pause game">Pause <span aria-hidden="true">Ⅱ</span></button>
              <button className={styles.secondaryButton} type="button" onClick={restartGame} aria-label="Restart game">Restart <span aria-hidden="true">↻</span></button>
            </div>
          )}
        </div>

        <section
          className={`${styles.panel} ${styles.holdPanel}`}
          aria-labelledby="hold-heading"
          aria-description={game?.canHold === false ? "Hold available after this piece locks." : "Hold stores one piece for later."}
        >
          {feedback?.kind === "hold" && (
            <span key={feedback.id} className={styles.holdFlash} aria-hidden="true" />
          )}
          <h3 id="hold-heading" className={styles.panelTitle}>Hold</h3>
          <PiecePreview type={game?.held ?? null} label="Held piece" />
        </section>

        <section className={styles.playfieldColumn} aria-label="Playfield">
          <div
            className={styles.boardFrame}
            ref={boardFrameRef}
            data-danger={dangerous || undefined}
          >
            {(feedback?.kind === "lock" || feedback?.kind === "levelUp") && (
              <span
                key={feedback.id}
                className={styles.frameEffect}
                data-kind={feedback.kind}
                aria-hidden="true"
              />
            )}
            <div
              className={styles.playfield}
              ref={playfieldRef}
              tabIndex={0}
              role="group"
              aria-label="Tetris playfield. Keyboard controls work whenever this page has focus."
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowDown ArrowUp X Z Space C P Escape"
              onClick={(event) => {
                if (event.target === boardRef.current) event.currentTarget.focus({ preventScroll: true });
              }}
              aria-describedby="keyboard-help"
            >
              <div className={styles.boardViewport}>
                <canvas
                  ref={boardRef}
                  className={styles.boardCanvas}
                  role="img"
                  aria-label="Tetris board. Game status and statistics are available as text outside the board."
                >
                  Tetris board. Game status and statistics are available as text outside the board.
                </canvas>
                {showOverlay && (
                  <div
                    className={`${styles.gameOverlay} ${game?.status === "over" ? styles.gameOverOverlay : ""}`}
                    data-state={game?.status ?? "ready"}
                    key={`overlay-${game?.status ?? "ready"}`}
                  >
                    <div className={styles.overlayCard}>
                      {game?.status === "paused" ? (
                        <>
                          <h3 className={styles.overlayTitle}>PAUSED</h3>
                          <div className={styles.overlayButtons}>
                            <button className={styles.primaryButton} type="button" onClick={resumeGame}>Resume <span aria-hidden="true">→</span></button>
                            <button className={styles.overlayRestart} type="button" onClick={restartGame}>Restart</button>
                            <button className={styles.overlayRestart} type="button" onClick={onMenu}>Main menu</button>
                          </div>
                        </>
                      ) : game?.status === "over" ? (
                        <>
                          <p className={styles.overlayEyebrow}>FINAL RUN</p>
                          <h3 className={styles.overlayTitle}>GAME OVER</h3>
                          <dl className={styles.resultGrid} aria-label="Final results">
                            <div><dt>Score</dt><dd>{formatScore(game.score)}</dd></div>
                            <div><dt>Lines</dt><dd>{game.lines}</dd></div>
                            <div><dt>Level</dt><dd>{game.level}</dd></div>
                            <div><dt>Best</dt><dd>{formatScore(bestScore)}</dd></div>
                          </dl>
                          {newBest && <p className={styles.newBestMessage}>NEW BEST</p>}
                          <div className={styles.overlayButtons}>
                            <button className={styles.primaryButton} type="button" onClick={restartGame}>Play again <span aria-hidden="true">↻</span></button>
                            <button className={styles.overlayRestart} type="button" onClick={onMenu}>Main menu</button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                )}
                {feedback && (
                  <div
                    key={feedback.id}
                    className={styles.feedbackLayer}
                    data-kind={feedback.kind}
                    aria-hidden="true"
                  >
                    {feedback.kind === "clear" && (
                      <div className={styles.clearPopup}>
                        <strong>{feedback.label}</strong>
                        {feedback.points > 0 && <span className={styles.feedbackPoints}>+{formatScore(feedback.points)}</span>}
                        {feedback.combo >= 2 && <span className={styles.comboBadge}>COMBO ×{feedback.combo}</span>}
                      </div>
                    )}
                    {feedback.kind === "levelUp" && (
                      <div className={styles.levelPopup}>
                        <span>{feedback.label}</span>
                        {feedback.points > 0 && <span className={styles.feedbackPoints}>+{formatScore(feedback.points)}</span>}
                        {feedback.combo >= 2 && <span className={styles.comboBadge}>COMBO ×{feedback.combo}</span>}
                      </div>
                    )}
                    {feedback.kind === "drop" && feedback.points > 0 && (
                      <div className={styles.dropPoints}>+{formatScore(feedback.points)}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {canvasUnavailable && (
              <p className={styles.canvasWarning} role="alert">The board display is unavailable. Game status, score, and keyboard guidance remain accessible.</p>
            )}
          </div>
        </section>

        <section className={`${styles.panel} ${styles.nextPanel}`} aria-labelledby="next-heading">
          <h3 id="next-heading" className={styles.panelTitle}>Next</h3>
          <ol
            className={`${styles.nextList} ${queueShift ? styles.queueShift : ""}`}
            key={game?.piecesPlaced ?? 0}
            aria-label="Next five pieces"
          >
            {queuedPieces.map((type, index) => (
              <li className={styles.nextPiece} key={`next-${index}`}>
                <PiecePreview type={type} label={`Next piece ${index + 1}`} />
              </li>
            ))}
          </ol>
        </section>

        <details className={`${styles.panel} ${styles.helpPanel}`}>
          <summary className={styles.helpSummary}>
            <span>Controls</span>
            <span className={styles.helpChevron} aria-hidden="true">⌄</span>
          </summary>
          <div className={styles.helpContent} id="keyboard-help">
            <dl className={styles.keyList}>
              <div><dt><kbd>←</kbd><kbd>→</kbd></dt><dd>Move</dd></div>
              <div><dt><kbd>↓</kbd></dt><dd>Soft drop</dd></div>
              <div><dt><kbd>↑</kbd> <span>or</span> <kbd>X</kbd></dt><dd>Rotate clockwise</dd></div>
              <div><dt><kbd>Z</kbd></dt><dd>Rotate back</dd></div>
              <div><dt><kbd>Space</kbd></dt><dd>Hard drop</dd></div>
              <div><dt><kbd>C</kbd></dt><dd>Hold piece</dd></div>
              <div><dt><kbd>P</kbd> <span>or</span> <kbd>Esc</kbd></dt><dd>Pause / resume</dd></div>
            </dl>
          </div>
        </details>
      </div>
        </>
      )}
      </div>
      {screen === "countdown" && (
        <div className={styles.countdownVeil}>
          <div className={styles.countdownStatus} role="status" aria-live="polite" aria-atomic="true">
            <p className={styles.countdownEyebrow}>SINGLEPLAYER</p>
            <span className={styles.countdownNumber} key={countdown ?? 3} aria-hidden="true">{countdown ?? 3}</span>
            <span className={styles.visuallyHidden}>Starting in {countdown ?? 3}</span>
            <p className={styles.countdownCaption}>Get ready</p>
          </div>
        </div>
      )}
    </main>
  );
}
