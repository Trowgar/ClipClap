import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@clipclap/shared"],
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  async redirects() {
    return [
      {
        source: "/crayo-ai-alternative",
        destination: "/crayo-alternative",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
