import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tetris — Single Player",
  description: "A responsive, keyboard-and-touch-friendly singleplayer Tetris game.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
