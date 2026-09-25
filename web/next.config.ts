import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a parent lockfile in "Claude Workspace" otherwise makes
  // Turbopack infer the wrong root.
  turbopack: {
    root: __dirname,
  },
  // The owner-only Docs route reads this file at runtime; make sure it ships with the deployment.
  outputFileTracingIncludes: {
    "/docs/content": ["./content/**"],
  },
};

export default nextConfig;
