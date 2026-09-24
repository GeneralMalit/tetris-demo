import type { PieceType } from "@/src/game/contracts";

export type PreviewShape = {
  columns: number;
  rows: number;
  cells: readonly (readonly [number, number])[];
};

export const previewShapes: Record<PieceType, PreviewShape> = {
  I: { columns: 4, rows: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  O: { columns: 2, rows: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { columns: 3, rows: 2, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { columns: 3, rows: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { columns: 3, rows: 2, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { columns: 3, rows: 2, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { columns: 3, rows: 2, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};
