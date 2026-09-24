import {
  HEIGHT,
  HIDDEN_ROWS,
  WIDTH,
  type GameState,
  type PieceType,
  type Point,
} from "../game/contracts";
import { getCells, getGhostY } from "../game/engine";

const PIECE_COLORS: Record<PieceType, string> = {
  I: "#31e6ee",
  O: "#ffdb45",
  T: "#e94bc5",
  S: "#9be94e",
  Z: "#ff5573",
  J: "#5589ff",
  L: "#ff9a43",
};
const GARBAGE_COLOR = "#75808c";

const BOARD_BACKGROUND = "#10161d";
const GRID_COLOR = "rgba(142, 166, 181, 0.12)";
function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawBlock(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
  color: string,
): void {
  const insetX = Math.max(0.7, cellWidth * 0.065);
  const insetY = Math.max(0.7, cellHeight * 0.065);
  const blockX = x + insetX;
  const blockY = y + insetY;
  const blockWidth = Math.max(0, cellWidth - insetX * 2);
  const blockHeight = Math.max(0, cellHeight - insetY * 2);
  if (blockWidth === 0 || blockHeight === 0) return;

  const radius = Math.min(blockWidth, blockHeight) * 0.1;
  roundedRectPath(context, blockX, blockY, blockWidth, blockHeight, radius);
  context.fillStyle = color;
  context.fill();

  context.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.045);
  context.strokeStyle = "rgba(8, 12, 16, 0.9)";
  context.stroke();

  context.beginPath();
  context.moveTo(blockX + radius + 1, blockY + 1);
  context.lineTo(blockX + blockWidth - radius - 1, blockY + 1);
  context.moveTo(blockX + 1, blockY + radius + 1);
  context.lineTo(blockX + 1, blockY + blockHeight - radius - 1);
  context.lineWidth = Math.max(0.8, Math.min(cellWidth, cellHeight) * 0.035);
  context.strokeStyle = "rgba(255, 255, 255, 0.42)";
  context.stroke();

  context.beginPath();
  context.moveTo(blockX + radius + 1, blockY + blockHeight - 1);
  context.lineTo(blockX + blockWidth - radius - 1, blockY + blockHeight - 1);
  context.moveTo(blockX + blockWidth - 1, blockY + radius + 1);
  context.lineTo(blockX + blockWidth - 1, blockY + blockHeight - radius - 1);
  context.strokeStyle = "rgba(0, 0, 0, 0.34)";
  context.stroke();
}

function drawGhostBlock(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
): void {
  const insetX = Math.max(1, cellWidth * 0.11);
  const insetY = Math.max(1, cellHeight * 0.11);
  const blockX = x + insetX;
  const blockY = y + insetY;
  const blockWidth = Math.max(0, cellWidth - insetX * 2);
  const blockHeight = Math.max(0, cellHeight - insetY * 2);
  if (blockWidth === 0 || blockHeight === 0) return;

  roundedRectPath(
    context,
    blockX,
    blockY,
    blockWidth,
    blockHeight,
    Math.min(blockWidth, blockHeight) * 0.2,
  );
  context.fillStyle = "rgba(205, 232, 241, 0.07)";
  context.fill();
  context.lineWidth = 1.2;
  context.strokeStyle = "rgba(192, 226, 238, 0.48)";
  context.setLineDash([3, 3]);
  context.stroke();
  context.setLineDash([]);
}

function drawCells(
  context: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  cellWidth: number,
  cellHeight: number,
): void {
  for (const point of points) {
    if (
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.x >= WIDTH ||
      point.y < HIDDEN_ROWS ||
      point.y >= HIDDEN_ROWS + HEIGHT
    ) continue;
    drawBlock(
      context,
      point.x * cellWidth,
      (point.y - HIDDEN_ROWS) * cellHeight,
      cellWidth,
      cellHeight,
      color,
    );
  }
}

/** Paints the visible 10×20 playfield into a resolution-aware canvas. */
export function renderBoard(canvas: HTMLCanvasElement, game: Pick<GameState, "board" | "active"> | null): boolean {
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return false;
  }
  if (!context) return false;

  const bounds = canvas.getBoundingClientRect();
  const cssWidth = bounds.width || canvas.clientWidth;
  const cssHeight = bounds.height || canvas.clientHeight || (cssWidth * HEIGHT) / WIDTH;
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth <= 0 ||
    cssHeight <= 0
  ) {
    return true;
  }

  const reportedScale = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const deviceScale =
    Number.isFinite(reportedScale) && reportedScale > 0 ? reportedScale : 1;
  const backingWidth = Math.max(1, Math.round(cssWidth * deviceScale));
  const backingHeight = Math.max(1, Math.round(cssHeight * deviceScale));
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;

  const scaleX = backingWidth / cssWidth;
  const scaleY = backingHeight / cssHeight;
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(0, 0, cssWidth, cssHeight);

  const cellWidth = cssWidth / WIDTH;
  const cellHeight = cssHeight / HEIGHT;
  context.save();
  context.beginPath();
  context.rect(0, 0, cssWidth, cssHeight);
  context.clip();

  context.beginPath();
  for (let column = 1; column < WIDTH; column += 1) {
    const x = column * cellWidth;
    context.moveTo(x, 0);
    context.lineTo(x, cssHeight);
  }
  for (let row = 1; row < HEIGHT; row += 1) {
    const y = row * cellHeight;
    context.moveTo(0, y);
    context.lineTo(cssWidth, y);
  }
  context.lineWidth = 1;
  context.strokeStyle = GRID_COLOR;
  context.stroke();

  if (game) {
    for (let row = HIDDEN_ROWS; row < HIDDEN_ROWS + HEIGHT; row += 1) {
      const cells = game.board[row];
      if (!cells) continue;
      for (let column = 0; column < WIDTH; column += 1) {
        const type = cells[column];
        if (type) {
          drawBlock(
            context,
            column * cellWidth,
            (row - HIDDEN_ROWS) * cellHeight,
            cellWidth,
            cellHeight,
            type === "G" ? GARBAGE_COLOR : PIECE_COLORS[type],
          );
        }
      }
    }

    const active = game.active;
    if (active) {
      const ghostY = getGhostY(game);
      if (ghostY > active.y) {
        const ghost = { ...active, y: ghostY };
        for (const point of getCells(ghost)) {
          if (
            !Number.isInteger(point.x) ||
            !Number.isInteger(point.y) ||
            point.x < 0 ||
            point.x >= WIDTH ||
            point.y < HIDDEN_ROWS ||
            point.y >= HIDDEN_ROWS + HEIGHT
          ) continue;
          drawGhostBlock(
            context,
            point.x * cellWidth,
            (point.y - HIDDEN_ROWS) * cellHeight,
            cellWidth,
            cellHeight,
          );
        }
      }
      drawCells(context, getCells(active), PIECE_COLORS[active.type], cellWidth, cellHeight);
    }
  }

  context.restore();
  context.strokeStyle = "rgba(191, 199, 187, 0.46)";
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, Math.max(0, cssWidth - 1), Math.max(0, cssHeight - 1));
  return true;
}
