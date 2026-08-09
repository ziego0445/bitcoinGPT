import type { NextConfig } from "next";

const isGitHubActions = process.env.GITHUB_ACTIONS === "true";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: isGitHubActions ? "/bitcoinGPT" : "",
  assetPrefix: isGitHubActions ? "/bitcoinGPT/" : "",
};

export default nextConfig;
