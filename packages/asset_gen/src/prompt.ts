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
  frameIndex: number
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
    'Change only the pose enough to imply motion; avoid changing species, armor design, colors, or facing angle.',
    'Single isolated frame only, not a sprite sheet, not multiple poses in one image.',
  ].join('\n');
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
