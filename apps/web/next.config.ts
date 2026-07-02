import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@clipclap/shared"],
  experimental: {
    serverActions: {
      bodySizeLimit: "5gb",
    },
  },
};

export default nextConfig;
