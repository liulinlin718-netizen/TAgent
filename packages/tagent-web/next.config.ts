import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  distDir: process.env.TAGENT_LOCAL_WEB === "1" ? ".next-local" : ".next",
  turbopack: { root: path.resolve(__dirname, "../..") },
};

export default nextConfig;
