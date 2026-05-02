import { z } from 'zod';

export const ASSET_API_VERSION = 1;

export const AssetKindSchema = z.enum([
  'enemy',
  'weapon_part',
  'suit_part',
  'projectile',
  'material',
  'building',
  'ui_icon',
]);

export const RenderTargetSchema = z.enum([
  'world_sprite',
  'inventory_icon',
  'ui_detail',
]);

export const AssetSizeSchema = z.union([
  z.literal(32),
  z.literal(64),
  z.literal(256),
]);

export const CameraSchema = z.enum([
  'top_down',
  'side_view',
  'three_quarter',
]);

export const RenderStyleSchema = z.enum([
  'pixel_art',
  'painted_sprite',
  'clean_icon',
]);

export const AnchorSchema = z.enum([
  'center',
  'center_bottom',
  'top_left',
]);

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const AssetStyleSchema = z.object({
  camera: CameraSchema,
  renderStyle: RenderStyleSchema,
  outline: z.boolean().default(true),
  transparentBackground: z.boolean().default(true),
});

export const GameObjectSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(160),
  faction: z.string().min(1).max(64).nullable().optional(),
  biome: z.string().min(1).max(96).nullable().optional(),
  tier: z.string().min(1).max(32).nullable().optional(),
  slot: z.string().min(1).max(64).nullable().optional(),
  weaponClass: z.string().min(1).max(64).nullable().optional(),
  materialId: z.string().min(1).max(64).nullable().optional(),
  buildingKind: z.string().min(1).max(64).nullable().optional(),
});

export const VisualBriefSchema = z.object({
  subject: z.string().min(1).max(280),
  materials: z.array(z.string().min(1).max(80)).max(12).default([]),
  colors: z.array(HexColorSchema).min(1).max(8),
  mustInclude: z.array(z.string().min(1).max(120)).max(12).default([]),
  mustAvoid: z.array(z.string().min(1).max(120)).max(12).default([]),
});

export const AssetConstraintsSchema = z.object({
  safeMarginPx: z.number().int().min(0).max(64).default(4),
  anchor: AnchorSchema.default('center_bottom'),
  maxOpaqueBoundsRatio: z.number().min(0.1).max(1).default(0.86),
  minReadableAtPx: z.union([z.literal(16), z.literal(32), z.literal(64)]).default(32),
});

export const AssetGenerateRequestSchema = z.object({
  requestId: z.string().min(1).max(128).optional(),
  assetKind: AssetKindSchema,
  renderTarget: RenderTargetSchema,
  size: AssetSizeSchema,
  style: AssetStyleSchema,
  gameObject: GameObjectSchema,
  visualBrief: VisualBriefSchema,
  constraints: AssetConstraintsSchema.default({}),
});

export const AssetPrewarmRequestSchema = z.object({
  requestId: z.string().min(1).max(128).optional(),
  reason: z.enum(['world_boot', 'floor_discovered', 'cycle_rollover', 'manual']).default('manual'),
  worldSeed: z.number().int().optional(),
  cycle: z.number().int().min(1).optional(),
  floorIndices: z.array(z.number().int().min(1)).max(64).default([]),
  requests: z.array(AssetGenerateRequestSchema).min(1).max(256),
});

export const JobStatusSchema = z.enum([
  'queued',
  'generating',
  'cleaning',
  'verifying',
  'approved',
  'rejected',
  'failed',
]);

export type AssetKind = z.infer<typeof AssetKindSchema>;
export type RenderTarget = z.infer<typeof RenderTargetSchema>;
export type AssetSize = z.infer<typeof AssetSizeSchema>;
export type AssetStyle = z.infer<typeof AssetStyleSchema>;
export type AssetGenerateRequest = z.infer<typeof AssetGenerateRequestSchema>;
export type AssetPrewarmRequest = z.infer<typeof AssetPrewarmRequestSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;

export type AssetMetadata = {
  width: number;
  height: number;
  transparent: boolean;
  anchor: { x: number; y: number };
  opaqueBounds: { x: number; y: number; w: number; h: number };
  averageColors: string[];
};

export type VerificationResult = {
  score: number;
  verdict: 'pass' | 'retry' | 'reject';
  summary: string;
  reasons: string[];
};

export type AssetRecord = {
  assetId: string;
  cacheKey: string;
  request: AssetGenerateRequest;
  urls: { png: string; webp?: string };
  metadata: AssetMetadata;
  verification: VerificationResult;
  createdAt: string;
};

export type AssetJob = {
  jobId: string;
  status: JobStatus;
  cacheKey: string;
  request: AssetGenerateRequest;
  assetId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
