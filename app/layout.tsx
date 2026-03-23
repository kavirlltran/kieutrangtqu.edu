import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SpeechAce Practice – Luyện phát âm tiếng Anh",
  description: "Luyện phát âm, đọc bài và nói tiếng Anh với SpeechAce AI scoring. Nhận phản hồi ngay lập tức từng từ.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
