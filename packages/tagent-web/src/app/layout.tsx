import type { Metadata, Viewport } from "next";
import "../styles/tokens.css";
import "./globals.css";
import AccessGate from '../components/AccessGate';

export const metadata: Metadata = {
  title: "TAgent — AI 办公协作助手",
  description: "可视化多 Agent 协作平台，让非技术用户也能轻松使用 AI Agent",
  metadataBase: new URL("http://localhost:3000"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a1a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body><AccessGate>{children}</AccessGate></body>
    </html>
  );
}
