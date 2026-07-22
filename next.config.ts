import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// i18n: плагин подключает src/i18n/request.ts (локаль из cookie, без роутинга).
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  images: {
    // Google account avatar in the header (UserBadge).
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
    ],
  },
};

export default withNextIntl(nextConfig);
