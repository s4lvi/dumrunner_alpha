import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

// Build stamp, computed at build time (i.e. on every deploy) and
// inlined as public env so the header can show which build is live.
// BUILD_NUMBER = git commit count (auto-increments per commit); SHA
// uniquely identifies the deploy even if the count is unavailable
// (e.g. a shallow CI clone). On Vercel VERCEL_GIT_COMMIT_SHA is
// always set; locally we fall back to git directly. All wrapped so a
// missing git / non-repo build can't fail the build.
function gitOut(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const commitSha =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  gitOut('git rev-parse --short HEAD') ||
  'dev';
const buildNumber = gitOut('git rev-list --count HEAD') || '0';

const config: NextConfig = {
  transpilePackages: ['@dumrunner/shared'],
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber,
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
  },
};

export default config;
