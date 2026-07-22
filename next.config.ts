import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Аватар Google-аккаунта в шапке (UserBadge).
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
    ],
  },
};

export default nextConfig;
