import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  async redirects() {
    // The ColorColor board moved to /play/colorcolor. Shared referral links are
    // /play?ref=0x…; Next passes the query through, so the referrer survives the redirect.
    return [{ source: "/play", destination: "/play/colorcolor", permanent: false }];
  },
};

export default nextConfig;
