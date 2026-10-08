import type { NextConfig } from "next";

// better-auth and pg must stay external to the server bundle: bundling
// duplicates the auth module (two instances disagreeing about cookies), and
// pg's native bindings do not survive it. Also found by comparison with the
// parallel run/crystal-flamingo-a2 implementation.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-auth", "pg"],
};

export default nextConfig;
