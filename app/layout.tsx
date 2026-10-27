import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "README Proof",
  description: "Runs your README on a clean machine and proves the fix before you merge it. NVIDIA Nemotron on Nebius Token Factory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
