import type { NextConfig } from "next";

// better-auth and pg must stay external: bundling them duplicates the module
// (two auth instances disagreeing about cookies) and pg's native bindings do
// not survive it.
const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-auth", "pg"],
};

export default config;
