import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

// Build stamp, computed at build time (i.e. on every deploy) and
// inlined as public env so the header can show which build is live.
//
// BUILD_NUMBER is derived from the HEAD commit's timestamp
// (YYMMDD.HHMM UTC) — NOT `git rev-list --count`, which silently
// returns the clone depth (~10, constant) on Vercel's shallow
// clones, so the chip never bumped between deploys. The timestamp
// works on a depth-1 clone, is monotonic per commit, and doubles as
// "when was this build cut" at a glance. SHA uniquely identifies
// the deploy. On Vercel VERCEL_GIT_COMMIT_SHA is always set;
// locally we fall back to git directly. All wrapped so a missing
// git / non-repo build can't fail the build.
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

function buildStamp(): string {
  const epochSec = parseInt(gitOut('git show -s --format=%ct HEAD'), 10);
  if (!Number.isFinite(epochSec)) return '0';
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}` +
    `${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  );
}
const buildNumber = buildStamp();

const config: NextConfig = {
  transpilePackages: ['@dumrunner/shared', '@dumrunner/asset_gen'],
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber,
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
  },
};

export default config;
