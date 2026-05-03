import type { AssetGenerateRequest } from './schemas.js';

const CAMERA_COPY: Record<AssetGenerateRequest['style']['camera'], string> = {
  top_down: 'top-down game sprite camera, readable from above',
  side_view: 'side-view sprite camera, clean profile silhouette',
  three_quarter: 'three-quarter game icon camera, readable silhouette',
};

const STYLE_COPY: Record<AssetGenerateRequest['style']['renderStyle'], string> = {
  pixel_art: 'crisp pixel-art inspired sprite, simple clusters, no antialias-heavy detail',
  painted_sprite: 'painted 2D game sprite, high readability at small size',
  clean_icon: 'clean inventory icon, centered object, strong silhouette',
};

export function compileAssetPrompt(request: AssetGenerateRequest): string {
  const object = request.gameObject;
  const brief = request.visualBrief;
  const parts = [
    `Create one ${request.assetKind} asset for DUM RUNNER.`,
    `Subject: ${brief.subject}.`,
    `Game object: ${object.label} (${object.id}).`,
    object.faction ? `Faction: ${object.faction}.` : '',
    object.biome ? `Biome: ${object.biome}.` : '',
    object.tier ? `Tier: ${object.tier}.` : '',
    object.slot ? `Part slot: ${object.slot}.` : '',
    object.weaponClass ? `Weapon class: ${object.weaponClass}.` : '',
    object.materialId ? `Material: ${object.materialId}.` : '',
    object.buildingKind ? `Building kind: ${object.buildingKind}.` : '',
    `Target: ${request.renderTarget}, final crop ${request.size}x${request.size}px.`,
    `Camera: ${CAMERA_COPY[request.style.camera]}.`,
    `Rendering: ${STYLE_COPY[request.style.renderStyle]}.`,
    request.style.outline ? 'Use a thin dark outline where it improves readability.' : '',
    `Palette: ${brief.colors.join(', ')}.`,
    brief.materials.length > 0 ? `Materials and surface detail: ${brief.materials.join(', ')}.` : '',
    brief.mustInclude.length > 0 ? `Must include: ${brief.mustInclude.join('; ')}.` : '',
    [
      'Must avoid: text, letters, numbers, logos, watermark, UI frame, hands, floor shadow that cannot be removed',
      ...brief.mustAvoid,
    ].join('; ') + '.',
    request.style.transparentBackground
      ? 'Use a fully transparent background if supported; otherwise use a plain, high-contrast, easily removable background.'
      : 'Use a plain, high-contrast, easily removable background.',
    'Leave generous padding around the subject.',
    'The result must be usable as a small game sprite after background removal.',
  ];
  return parts.filter(Boolean).join('\n');
}

export function compileAnimationFramePrompt(
  request: AssetGenerateRequest,
  frameIndex: number,
  correction?: string
): string {
  if (!request.animation) {
    return compileAssetPrompt(request);
  }

  const base = compileAssetPrompt(request);
  const action = request.animation.action;
  const cyclePosition = `${frameIndex + 1} of ${request.animation.frameCount}`;
  const frameDirection = actionCopy(action, frameIndex, request.animation.frameCount);

  return [
    base,
    '',
    request.animation.baseAssetId
      ? 'Use the provided reference image as the canonical sprite. Preserve its creature identity, palette, outline weight, camera angle, and scale.'
      : '',
    `Animation frame: ${cyclePosition} for a ${action} cycle.`,
    `Pose direction: ${frameDirection}.`,
    'Keep the exact same character identity, palette, scale, camera angle, and silhouette family across all frames.',
    'Use identical hue, saturation, and material colors in every frame. Do not shift purple, green, shadow, or highlight colors between frames.',
    'Change only the pose enough to imply motion; avoid changing species, armor design, colors, or facing angle.',
    correction ? `Correction from failed validation: ${correction}.` : '',
    'Single isolated frame only, not a sprite sheet, not multiple poses in one image.',
  ].filter(Boolean).join('\n');
}

// Single-call sheet prompt: ask the model for an N-pose horizontal strip
// in ONE generation, anchored to the reference sprite. Per-frame coherence
// (palette, identity, scale) is far better within a single generation than
// across N independent calls.
export function compileAnimationSheetPrompt(
  request: AssetGenerateRequest,
  correction?: string
): string {
  if (!request.animation) {
    return compileAssetPrompt(request);
  }
  const base = compileAssetPrompt(request);
  const action = request.animation.action;
  const N = request.animation.frameCount;
  const poses = posesForAction(action, N);
  const poseLines = poses.map((p, i) => `Frame ${i + 1}: ${p}.`);

  return [
    base,
    '',
    request.animation.baseAssetId
      ? 'A reference image of the canonical character is provided. Preserve its creature identity, palette, outline weight, camera angle, and scale across every frame in the output sheet.'
      : 'Pick a single canonical look for the character and reuse it identically across every frame.',
    '',
    `Output a single ${action} animation strip with exactly ${N} equal-width frames laid out left to right in one image.`,
    `Each frame is a separate isolated pose of THE SAME character on a fully transparent background.`,
    `Frames are evenly spaced across the full canvas width, filling the canvas. Do not stack frames vertically. Do not produce a 2x2 grid. Do not add gutters, borders, captions, or numbers.`,
    `All frames share the same scale, anchor, vertical foot baseline, palette, and outline weight. The character's centre line stays at the centre of each frame.`,
    'Pose breakdown:',
    ...poseLines,
    'Only the pose changes between frames — the species, armour, palette, accents, and camera angle must be identical across the strip.',
    correction ? `Correction from prior failed attempt: ${correction}.` : '',
  ].filter(Boolean).join('\n');
}

function posesForAction(action: string, frameCount: number): string[] {
  switch (action) {
    case 'idle':
      return frameCount === 2
        ? ['neutral compact breathing pose', 'slightly raised breathing pose, same footing']
        : frameCount === 3
        ? [
            'neutral compact breathing pose',
            'mid-rise breathing pose, same footing',
            'top-of-breath pose, same footing',
          ]
        : [
            'neutral compact breathing pose',
            'mid-rise breathing pose',
            'top-of-breath pose',
            'returning to neutral pose',
          ];
    case 'walk':
      return frameCount === 2
        ? ['left-foot-forward stride', 'right-foot-forward stride']
        : frameCount === 3
        ? ['left-foot-forward stride', 'centred passing pose', 'right-foot-forward stride']
        : [
            'left-foot-forward stride',
            'centred passing pose',
            'right-foot-forward stride',
            'centred recovery passing pose',
          ];
    case 'attack':
      return frameCount === 2
        ? ['wind-up attack pose, weight back', 'strike follow-through pose, weight forward']
        : frameCount === 3
        ? [
            'wind-up attack pose, weight back',
            'impact strike pose, weight forward',
            'follow-through recovery pose',
          ]
        : [
            'wind-up attack pose, weight back',
            'mid-strike pose, lunging forward',
            'impact strike pose, fully extended',
            'follow-through recovery pose, returning to ready',
          ];
    case 'death':
      return frameCount === 2
        ? ['staggered collapsing pose', 'fallen corpse pose']
        : frameCount === 3
        ? ['staggered collapsing pose', 'mid-fall pose', 'fallen corpse pose']
        : [
            'staggered collapsing pose, weapon dropping',
            'mid-fall pose, body angled',
            'fallen pose, hitting the ground',
            'settled corpse pose',
          ];
    default:
      return Array.from({ length: frameCount }, (_, i) => `subtle animation pose ${i + 1}`);
  }
}

function actionCopy(action: string, frameIndex: number, frameCount: number): string {
  const t = frameCount <= 1 ? 0 : frameIndex / (frameCount - 1);
  switch (action) {
    case 'idle':
      return t < 0.5
        ? 'neutral breathing pose, compact silhouette'
        : 'slightly raised breathing pose, same footing and silhouette';
    case 'walk':
      if (frameCount === 2) return frameIndex === 0 ? 'left-step stride' : 'right-step stride';
      if (frameCount === 3) return ['left-step stride', 'center passing pose', 'right-step stride'][frameIndex] ?? 'walk pose';
      return ['left-step stride', 'center passing pose', 'right-step stride', 'center recovery pose'][frameIndex] ?? 'walk pose';
    case 'attack':
      if (frameCount === 2) return frameIndex === 0 ? 'wind-up attack pose' : 'strike follow-through pose';
      return ['wind-up attack pose', 'impact strike pose', 'follow-through recovery pose', 'return-to-ready pose'][frameIndex] ?? 'attack pose';
    case 'death':
      if (frameCount === 2) return frameIndex === 0 ? 'collapsing pose' : 'fallen corpse pose';
      return ['staggering collapse pose', 'falling pose', 'fallen corpse pose', 'settled corpse pose'][frameIndex] ?? 'death pose';
    default:
      return 'subtle animation pose';
  }
}
