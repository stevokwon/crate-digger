import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crate Digger",
  description: "Open-format DJ mixer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-white antialiased">{children}</body>
    </html>
  );
}
