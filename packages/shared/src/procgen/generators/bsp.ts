import type { Region, RegionSet } from '../regions';

export type BspConfig = {
  bounds: { tileX: number; tileY: number; tileW: number; tileH: number };
  minLeafTiles: number;
  maxDepth: number;
  splitJitter: number;
};

const DEFAULT_BSP: BspConfig = {
  bounds: { tileX: -30, tileY: -30, tileW: 60, tileH: 60 },
  minLeafTiles: 8,
  maxDepth: 5,
  splitJitter: 0.3,
};

export function generateBspRegions(
  rng: () => number,
  cfg?: Partial<BspConfig>,
): RegionSet {
  const config: BspConfig = { ...DEFAULT_BSP, ...cfg };
  const leaves: Region[] = [];
  splitRecursive(
    {
      tileX: config.bounds.tileX,
      tileY: config.bounds.tileY,
      tileW: config.bounds.tileW,
      tileH: config.bounds.tileH,
      category: 'hazard',
    },
    0,
    config,
    rng,
    leaves,
  );
  if (leaves.length > 0) {
    leaves[0].category = 'safe';
  }
  return {
    regions: leaves,
    spawnRegionIndex: 0,
    stairsRegionIndex: leaves.length > 1 ? leaves.length - 1 : null,
  };
}

function splitRecursive(
  r: Region,
  depth: number,
  cfg: BspConfig,
  rng: () => number,
  out: Region[],
): void {
  const canSplit =
    depth < cfg.maxDepth &&
    Math.min(r.tileW, r.tileH) >= cfg.minLeafTiles * 2;
  if (!canSplit) {
    out.push(r);
    return;
  }
  const horizontal = r.tileW >= r.tileH;
  const length = horizontal ? r.tileW : r.tileH;
  const jitter = (rng() - 0.5) * 2 * cfg.splitJitter;
  let cut = Math.round(length * (0.5 + jitter * 0.5));
  cut = Math.max(cfg.minLeafTiles, Math.min(length - cfg.minLeafTiles, cut));
  if (horizontal) {
    splitRecursive({ ...r, tileW: cut }, depth + 1, cfg, rng, out);
    splitRecursive(
      { ...r, tileX: r.tileX + cut, tileW: r.tileW - cut },
      depth + 1,
      cfg,
      rng,
      out,
    );
  } else {
    splitRecursive({ ...r, tileH: cut }, depth + 1, cfg, rng, out);
    splitRecursive(
      { ...r, tileY: r.tileY + cut, tileH: r.tileH - cut },
      depth + 1,
      cfg,
      rng,
      out,
    );
  }
}
