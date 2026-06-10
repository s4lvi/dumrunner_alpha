// The v2 renderer's sector data shapes live in @dumrunner/shared/sector
// now that the polygon-collision phase needs the server speaking the
// same model. This module re-exports the shared types under the
// historical names so the rest of fps.v2 can keep importing from
// `./types` without churn.

export type {
  Vec2,
} from '@dumrunner/shared';
export type {
  Sector,
  Wall,
  SectorMap,
  SectorLight as V2Light,
} from '@dumrunner/shared';
