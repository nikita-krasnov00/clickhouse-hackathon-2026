import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Google account avatar in the header (UserBadge).
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
    ],
  },
};

export default nextConfig;
