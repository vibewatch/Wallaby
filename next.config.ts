import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  transpilePackages: ["@wallaby/graby"],
  outputFileTracingIncludes: {
    "/*": [
      "./packages/graby-site-config/configs/**/*.txt",
      "./node_modules/@fontsource/unifont/files/unifont-latin-400-normal.woff2",
    ],
  },
};

export default nextConfig;
