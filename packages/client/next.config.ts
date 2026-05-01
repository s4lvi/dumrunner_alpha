import type { NextConfig } from 'next';

const config: NextConfig = {
  // Allow loading env from the repo root .env.local during dev.
  experimental: {
    // Lets Next transpile the @dumrunner/shared workspace package.
  },
  transpilePackages: ['@dumrunner/shared'],
  reactStrictMode: true,
};

export default config;
