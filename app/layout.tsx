import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SpeechAce Reading Practice",
  description: "Read-aloud practice with SpeechAce scoring + Telegram notification",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
