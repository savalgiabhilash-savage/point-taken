import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a parent lockfile in "Claude Workspace" otherwise makes
  // Turbopack infer the wrong root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
