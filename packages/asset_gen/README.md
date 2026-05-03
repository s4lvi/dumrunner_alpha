# DUM RUNNER Asset Gen

Backend-only asset generation service for game sprites and icons.

## Local Run

Required for real generation:

```bash
OPENAI_API_KEY=...
ASSET_GEN_SERVICE_TOKEN=local-dev-token
```

Useful defaults:

```bash
ASSET_GEN_PORT=8787
ASSET_GEN_PUBLIC_BASE_URL=http://localhost:8787
ASSET_GEN_STORAGE_DIR=.asset_gen
ASSET_GEN_IMAGE_MODEL=gpt-image-1.5
ASSET_GEN_IMAGE_QUALITY=low
ASSET_GEN_IMAGE_SIZE=1024x1024
```

Start the service:

```bash
npm run dev:asset_gen
```

Health check:

```bash
curl http://localhost:8787/health
```

Approved asset index:

```bash
curl -H "Authorization: Bearer local-dev-token" \
  http://localhost:8787/v1/assets/index
```

## Prewarm

Preview the current generated request catalog without hitting the service:

```bash
npm --workspace @dumrunner/asset_gen run prewarm -- --dry-run
```

Submit the default alpha catalog to a running service:

```bash
npm --workspace @dumrunner/asset_gen run prewarm
```

Submit the exhaustive part matrix:

```bash
npm --workspace @dumrunner/asset_gen run prewarm -- --all-parts
```

## Smoke Tests

Generate one enemy and one material:

```bash
./node_modules/.bin/dotenv -e .env.local -- \
  npm --workspace @dumrunner/asset_gen run smoke
```

Generate one 2-frame enemy idle spritesheet:

```bash
./node_modules/.bin/dotenv -e .env.local -- \
  npm --workspace @dumrunner/asset_gen run smoke -- --animation
```

Generate specific reference-guided animation cycles:

```bash
./node_modules/.bin/dotenv -e .env.local -- \
  npm --workspace @dumrunner/asset_gen run smoke -- --animation --action walk --frames 4
```

```bash
./node_modules/.bin/dotenv -e .env.local -- \
  npm --workspace @dumrunner/asset_gen run smoke -- --animation --action attack --frames 3
```

## Current Limits

- `sharp` now produces exact-size PNG outputs and alpha-aware metadata.
- `enemy_animation` jobs produce horizontal PNG spritesheets with frame
  metadata. This is intended for short 2-4 frame cycles, not rich full-motion
  animation.
- Animation assembly normalizes non-reference frames toward frame 0's visible
  pixel palette before sheet output, which reduces model-induced hue shifts
  between generated poses.
- Approved assets carry `family` metadata so base sprites and generated cycles
  can be grouped by identity source, variant type, action, and source model.
- Animation verification now measures alpha-mask overlap, palette drift,
  center drift, and visible-area ratio across the whole frame set. A failed
  cycle gets one corrective regeneration pass with a targeted prompt.
- The service still depends on the image model producing a useful transparent
  source image. It does not yet run semantic background matting for opaque
  images.
- The verifier is mechanical only. A production VLM verifier still needs to
  grade subject match, silhouette readability, and forbidden elements.
