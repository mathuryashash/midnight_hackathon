/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [],
  env: {
    NEXT_PUBLIC_USE_MOCK:
      process.env.NEXT_PUBLIC_USE_MOCK ?? "true",
    NEXT_PUBLIC_RELAYER_URL:
      process.env.NEXT_PUBLIC_RELAYER_URL ?? "ws://localhost:3001",
  },
};

module.exports = nextConfig;
