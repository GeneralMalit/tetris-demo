export interface ArcadeFeedback {
  id: number;
  kind: "drop" | "lock" | "clear" | "hold" | "levelUp";
  label: string;
  points: number;
  combo: number;
}
