import {
  HEIGHT,
  HIDDEN_ROWS,
  WIDTH,
  type GameEvent,
  type PieceType,
  type Point,
} from "../game/contracts";

const PIECE_COLORS: Record<PieceType, string> = {
  I: "#31e6ee",
  O: "#ffdb45",
  T: "#e94bc5",
  S: "#9be94e",
  Z: "#ff5573",
  J: "#5589ff",
  L: "#ff9a43",
};

const CYAN = "#36e7ee";
const PINK = "#ff51aa";
const IVORY = "#f5f5df";
const MAX_EFFECTS = 32;
const MAX_PIECE_CELLS = 4;
const MAX_PARTICLES = 12;
const REDUCED_OUTLINE_MS = 120;
const DROP_TRAIL_MS = 180;
const DROP_PARTICLE_MS = 250;
const LOCK_OUTLINE_MS = 120;
const CLEAR_SWEEP_MS = 220;
const CLEAR_PARTICLE_MS = 400;
const LEVEL_SWEEP_MS = 500;

type Particle = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  color: string;
  size: number;
};

type DropEffect = {
  kind: "drop";
  startedAt: number;
  from: Point[];
  to: Point[];
  color: string;
  particles: Particle[];
};

type LockEffect = {
  kind: "lock";
  startedAt: number;
  cells: Point[];
  color: string;
};

type ClearEffect = {
  kind: "clear";
  startedAt: number;
  rows: number[];
  count: number;
  particles: Particle[];
};

type LevelUpEffect = {
  kind: "levelUp";
  startedAt: number;
};

type ArcadeEffect = DropEffect | LockEffect | ClearEffect | LevelUpEffect;

function isBoardPoint(point: Point | undefined): point is Point {
  return Boolean(
    point &&
      Number.isInteger(point.x) &&
      Number.isInteger(point.y) &&
      point.x >= 0 &&
      point.x < WIDTH &&
      point.y >= 0 &&
      point.y < HIDDEN_ROWS + HEIGHT,
  );
}

function snapshotPoints(points: Point[], limit = MAX_PIECE_CELLS): Point[] {
  const snapshot: Point[] = [];
  for (let index = 0; index < points.length && index < limit; index += 1) {
    const point = points[index];
    if (isBoardPoint(point)) snapshot.push({ x: point.x, y: point.y });
  }
  return snapshot;
}

function makeDropParticles(cells: Point[], color: string): Particle[] {
  const particles: Particle[] = [];
  const fanAngles = [-2.62, -1.57, -0.52];
  for (let cellIndex = 0; cellIndex < cells.length && particles.length < MAX_PARTICLES; cellIndex += 1) {
    const point = cells[cellIndex];
    for (let spark = 0; spark < fanAngles.length && particles.length < MAX_PARTICLES; spark += 1) {
      const angle = fanAngles[(spark + cellIndex) % fanAngles.length];
      const reach = 0.22 + ((cellIndex + spark) % 3) * 0.1;
      particles.push({
        x: point.x + 0.5,
        y: point.y + 0.5,
        dx: Math.cos(angle) * reach,
        dy: Math.sin(angle) * reach,
        color: (spark + cellIndex) % 2 === 0 ? color : CYAN,
        size: 0.075 + ((cellIndex + spark) % 2) * 0.025,
      });
    }
  }
  return particles;
}

function makeClearParticles(rows: number[]): Particle[] {
  const particles: Particle[] = [];
  const origins = [0.35, WIDTH / 2, WIDTH - 0.35];
  for (let rowIndex = 0; rowIndex < rows.length && particles.length < MAX_PARTICLES; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let spark = 0; spark < origins.length && particles.length < MAX_PARTICLES; spark += 1) {
      particles.push({
        x: origins[spark],
        y: row + 0.5,
        dx: (spark - 1) * 0.16,
        dy: -0.42 - ((spark + rowIndex) % 2) * 0.18,
        color: (spark + rowIndex) % 2 === 0 ? CYAN : PINK,
        size: 0.07 + (spark % 2) * 0.025,
      });
    }
  }
  return particles;
}


function strokeCellOutline(
  context: CanvasRenderingContext2D,
  point: Point,
  cellWidth: number,
  cellHeight: number,
  color: string,
  alpha: number,
  lineWidth: number,
): void {
  const insetX = Math.max(1, cellWidth * 0.12);
  const insetY = Math.max(1, cellHeight * 0.12);
  context.globalAlpha = alpha;
  context.lineWidth = lineWidth;
  context.strokeStyle = color;
  context.strokeRect(
    point.x * cellWidth + insetX,
    (point.y - HIDDEN_ROWS) * cellHeight + insetY,
    Math.max(0, cellWidth - insetX * 2),
    Math.max(0, cellHeight - insetY * 2),
  );
}

/** Draws short-lived, event-snapshot-based effects over an already painted board. */
export class ArcadeEffects {
  private effects: ArcadeEffect[] = [];

  push(event: GameEvent, now: number): void {
    if (!Number.isFinite(now)) return;

    let effect: ArcadeEffect | null = null;
    switch (event.type) {
      case "hardDrop": {
        const from: Point[] = [];
        const to: Point[] = [];
        for (
          let index = 0;
          index < event.from.length && index < MAX_PIECE_CELLS && index < event.to.length;
          index += 1
        ) {
          const start = event.from[index];
          const end = event.to[index];
          if (isBoardPoint(start) && isBoardPoint(end)) {
            from.push({ x: start.x, y: start.y });
            to.push({ x: end.x, y: end.y });
          }
        }
        const landingCells = snapshotPoints(event.to);
        if (landingCells.length > 0) {
          const color = PIECE_COLORS[event.piece];
          effect = {
            kind: "drop",
            startedAt: now,
            from,
            to,
            color,
            particles: makeDropParticles(landingCells, color),
          };
        }
        break;
      }
      case "lock": {
        const cells = snapshotPoints(event.cells);
        if (cells.length > 0) {
          effect = {
            kind: "lock",
            startedAt: now,
            cells,
            color: PIECE_COLORS[event.piece],
          };
        }
        break;
      }
      case "clear": {
        const rows: number[] = [];
        for (
          let index = 0;
          index < event.rows.length && rows.length < 4 && index < HIDDEN_ROWS + HEIGHT;
          index += 1
        ) {
          const row = event.rows[index];
          if (
            Number.isInteger(row) &&
            row >= 0 &&
            row < HIDDEN_ROWS + HEIGHT &&
            !rows.includes(row)
          ) {
            rows.push(row);
          }
        }
        if (rows.length > 0) {
          effect = {
            kind: "clear",
            startedAt: now,
            rows,
            count: Number.isFinite(event.count)
              ? Math.max(1, Math.min(4, Math.trunc(event.count)))
              : rows.length,
            particles: makeClearParticles(rows),
          };
        }
        break;
      }
      case "levelUp":
        effect = { kind: "levelUp", startedAt: now };
        break;
      case "gameOver":
        this.clear();
        return;
      case "move":
      case "rotate":
      case "hold":
        return;
    }

    if (effect) {
      if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
      this.effects.push(effect);
    }
  }

  clear(): void {
    this.effects.length = 0;
  }

  hasActive(now: number): boolean {
    if (!Number.isFinite(now)) return this.effects.length > 0;

    let writeIndex = 0;
    for (const effect of this.effects) {
      const lifetime = effect.kind === "drop"
        ? DROP_PARTICLE_MS
        : effect.kind === "lock"
          ? LOCK_OUTLINE_MS
          : effect.kind === "clear"
            ? CLEAR_PARTICLE_MS
            : LEVEL_SWEEP_MS;
      if (now - effect.startedAt < lifetime) {
        this.effects[writeIndex] = effect;
        writeIndex += 1;
      }
    }
    this.effects.length = writeIndex;
    return writeIndex > 0;
  }

  draw(canvas: HTMLCanvasElement, now: number, reducedMotion: boolean): void {
    if (!Number.isFinite(now) || this.effects.length === 0) return;

    let context: CanvasRenderingContext2D | null;
    try {
      context = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!context) return;

    const bounds = canvas.getBoundingClientRect();
    const cssWidth = bounds.width || canvas.clientWidth;
    const cssHeight = bounds.height || canvas.clientHeight || (cssWidth * HEIGHT) / WIDTH;
    if (
      !Number.isFinite(cssWidth) ||
      !Number.isFinite(cssHeight) ||
      cssWidth <= 0 ||
      cssHeight <= 0 ||
      canvas.width <= 0 ||
      canvas.height <= 0
    ) {
      return;
    }

    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;
    const cellWidth = cssWidth / WIDTH;
    const cellHeight = cssHeight / HEIGHT;

    context.save();
    try {
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      context.beginPath();
      context.rect(0, 0, cssWidth, cssHeight);
      context.clip();

      for (const effect of this.effects) {
        if (reducedMotion) {
          this.drawReducedOutline(context, effect, now, cssWidth, cssHeight, cellWidth, cellHeight);
          continue;
        }
        switch (effect.kind) {
          case "drop":
            this.drawDrop(context, effect, now, cellWidth, cellHeight);
            break;
          case "lock":
            this.drawLock(context, effect, now, cellWidth, cellHeight);
            break;
          case "clear":
            this.drawClear(context, effect, now, cssWidth, cellWidth, cellHeight);
            break;
          case "levelUp":
            this.drawLevelUp(context, effect, now, cssWidth, cssHeight, cellWidth, cellHeight);
            break;
        }
      }
    } finally {
      context.restore();
    }
  }

  private drawReducedOutline(
    context: CanvasRenderingContext2D,
    effect: ArcadeEffect,
    now: number,
    cssWidth: number,
    cssHeight: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const age = now - effect.startedAt;
    if (age < 0 || age >= REDUCED_OUTLINE_MS) return;
    const alpha = 0.16 * (1 - age / REDUCED_OUTLINE_MS);
    context.setLineDash([]);
    switch (effect.kind) {
      case "drop":
        for (const point of effect.to) {
          strokeCellOutline(context, point, cellWidth, cellHeight, CYAN, alpha, 1.2);
        }
        break;
      case "lock":
        for (const point of effect.cells) {
          strokeCellOutline(context, point, cellWidth, cellHeight, effect.color, alpha, 1.2);
        }
        break;
      case "clear":
        context.globalAlpha = alpha;
        context.lineWidth = 1.2;
        context.strokeStyle = CYAN;
        for (const row of effect.rows) {
          const y = (row - HIDDEN_ROWS) * cellHeight + cellHeight / 2;
          context.strokeRect(0, y - cellHeight * 0.32, cssWidth, cellHeight * 0.64);
        }
        break;
      case "levelUp":
        context.globalAlpha = alpha;
        context.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.08);
        context.strokeStyle = CYAN;
        context.strokeRect(0.5, 0.5, Math.max(0, cssWidth - 1), Math.max(0, cssHeight - 1));
        break;
    }
  }

  private drawDrop(
    context: CanvasRenderingContext2D,
    effect: DropEffect,
    now: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const age = now - effect.startedAt;
    const trailProgress = Math.max(0, Math.min(1, (now - effect.startedAt) / DROP_TRAIL_MS));
    const trailAlpha = Math.max(0, 0.34 * (1 - trailProgress));
    if (trailAlpha > 0 && age >= 0) {
      context.globalAlpha = trailAlpha;
      context.lineCap = "round";
      context.lineWidth = Math.max(1.5, Math.min(cellWidth, cellHeight) * 0.2);
      context.strokeStyle = effect.color;
      context.beginPath();
      for (let index = 0; index < effect.from.length; index += 1) {
        const from = effect.from[index];
        const to = effect.to[index];
        const x = (from.x + 0.5) * cellWidth;
        context.moveTo(x, (from.y - HIDDEN_ROWS + 0.5) * cellHeight);
        context.lineTo((to.x + 0.5) * cellWidth, (to.y - HIDDEN_ROWS + 0.5) * cellHeight);
      }
      context.stroke();

      context.globalAlpha = trailAlpha * 0.62;
      context.lineWidth = Math.max(0.8, Math.min(cellWidth, cellHeight) * 0.055);
      context.strokeStyle = CYAN;
      context.stroke();
    }

    if (age < 0 || age >= DROP_PARTICLE_MS) return;
    const particleProgress = age / DROP_PARTICLE_MS;
    const particleAlpha = (1 - particleProgress) * 0.86;
    context.globalAlpha = particleAlpha;
    context.lineCap = "round";
    context.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.07);
    for (const particle of effect.particles) {
      const x = particle.x * cellWidth;
      const y = (particle.y - HIDDEN_ROWS) * cellHeight;
      const endX = x + particle.dx * cellWidth * particleProgress;
      const endY = y + particle.dy * cellHeight * particleProgress;
      context.strokeStyle = particle.color;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(endX, endY);
      context.stroke();
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(endX, endY, Math.max(0.8, Math.min(cellWidth, cellHeight) * particle.size), 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawLock(
    context: CanvasRenderingContext2D,
    effect: LockEffect,
    now: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const age = now - effect.startedAt;
    if (age < 0 || age >= LOCK_OUTLINE_MS) return;
    const alpha = (1 - age / LOCK_OUTLINE_MS) * 0.72;
    context.setLineDash([]);
    for (const point of effect.cells) {
      strokeCellOutline(
        context,
        point,
        cellWidth,
        cellHeight,
        effect.color,
        alpha * 0.65,
        Math.max(1.2, Math.min(cellWidth, cellHeight) * 0.08),
      );
      strokeCellOutline(
        context,
        point,
        cellWidth,
        cellHeight,
        IVORY,
        alpha * 0.7,
        Math.max(0.8, Math.min(cellWidth, cellHeight) * 0.035),
      );
    }
  }

  private drawClear(
    context: CanvasRenderingContext2D,
    effect: ClearEffect,
    now: number,
    cssWidth: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const age = now - effect.startedAt;
    if (age >= 0 && age < CLEAR_SWEEP_MS) {
      const sweepProgress = age / CLEAR_SWEEP_MS;
      const head = cssWidth * sweepProgress;
      const tailWidth = Math.max(cellWidth * 1.4, cssWidth * 0.2);
      const start = Math.max(0, head - tailWidth);
      const intensity = effect.count >= 3 ? 0.92 : 0.72;
      const alpha = (1 - sweepProgress) * intensity;
      context.globalAlpha = alpha;
      context.lineCap = "round";
      for (let index = 0; index < effect.rows.length; index += 1) {
        const y = (effect.rows[index] - HIDDEN_ROWS + 0.5) * cellHeight;
        const color = index % 2 === 0 ? CYAN : PINK;
        context.beginPath();
        context.moveTo(start, y);
        context.lineTo(head, y);
        context.lineWidth = cellHeight * (effect.count >= 3 ? 0.72 : 0.5);
        context.strokeStyle = color;
        context.stroke();
        context.globalAlpha = alpha * 0.78;
        context.beginPath();
        context.moveTo(Math.max(start, head - Math.max(2, cellWidth * 0.36)), y);
        context.lineTo(head, y);
        context.lineWidth = Math.max(1.2, cellHeight * 0.18);
        context.strokeStyle = IVORY;
        context.stroke();
        context.globalAlpha = alpha;
      }
    }

    if (age < 0 || age >= CLEAR_PARTICLE_MS) return;
    const particleProgress = age / CLEAR_PARTICLE_MS;
    context.globalAlpha = (1 - particleProgress) * (effect.count >= 3 ? 0.86 : 0.68);
    context.lineCap = "round";
    context.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.065);
    for (const particle of effect.particles) {
      const x = particle.x * cellWidth;
      const y = (particle.y - HIDDEN_ROWS) * cellHeight;
      const endX = x + particle.dx * cellWidth * particleProgress;
      const endY = y + particle.dy * cellHeight * particleProgress;
      context.strokeStyle = particle.color;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(endX, endY);
      context.stroke();
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(endX, endY, Math.max(0.8, Math.min(cellWidth, cellHeight) * particle.size), 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawLevelUp(
    context: CanvasRenderingContext2D,
    effect: LevelUpEffect,
    now: number,
    cssWidth: number,
    cssHeight: number,
    cellWidth: number,
    cellHeight: number,
  ): void {
    const age = now - effect.startedAt;
    if (age < 0 || age >= LEVEL_SWEEP_MS) return;
    const sweepProgress = age / LEVEL_SWEEP_MS;
    const perimeter = 2 * (cssWidth + cssHeight);
    const dashLength = perimeter * 0.16;
    context.globalAlpha = 0.5 * (1 - sweepProgress * 0.55);
    context.lineWidth = Math.max(1.4, Math.min(cellWidth, cellHeight) * 0.09);
    context.strokeStyle = CYAN;
    context.setLineDash([dashLength, perimeter - dashLength]);
    context.lineDashOffset = -sweepProgress * perimeter;
    context.beginPath();
    context.rect(context.lineWidth / 2, context.lineWidth / 2, cssWidth - context.lineWidth, cssHeight - context.lineWidth);
    context.stroke();
    context.setLineDash([]);
    context.lineDashOffset = 0;
  }
}
