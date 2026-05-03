const state = {
  assets: [],
  filtered: [],
  selected: null,
  selectedImage: null,
  baseImage: null,
  frameIndex: 0,
  playing: true,
  fps: 8,
  lastTime: 0,
  accumulator: 0,
  overlays: true,
};

const els = {
  tokenInput: document.querySelector('#tokenInput'),
  loadButton: document.querySelector('#loadButton'),
  filterInput: document.querySelector('#filterInput'),
  assetSelect: document.querySelector('#assetSelect'),
  assetCount: document.querySelector('#assetCount'),
  stageCanvas: document.querySelector('#stageCanvas'),
  baseCanvas: document.querySelector('#baseCanvas'),
  playButton: document.querySelector('#playButton'),
  prevButton: document.querySelector('#prevButton'),
  nextButton: document.querySelector('#nextButton'),
  fpsSlider: document.querySelector('#fpsSlider'),
  fpsValue: document.querySelector('#fpsValue'),
  overlayToggle: document.querySelector('#overlayToggle'),
  frameLabel: document.querySelector('#frameLabel'),
  details: document.querySelector('#details'),
};

const stageCtx = els.stageCanvas.getContext('2d');
const baseCtx = els.baseCanvas.getContext('2d');
stageCtx.imageSmoothingEnabled = false;
baseCtx.imageSmoothingEnabled = false;

els.tokenInput.value = localStorage.getItem('asset_gen_token') ?? '';
els.loadButton.addEventListener('click', loadAssets);
els.filterInput.addEventListener('input', applyFilter);
els.assetSelect.addEventListener('change', selectCurrent);
els.playButton.addEventListener('click', () => {
  state.playing = !state.playing;
  els.playButton.textContent = state.playing ? 'Pause' : 'Play';
});
els.prevButton.addEventListener('click', () => stepFrame(-1));
els.nextButton.addEventListener('click', () => stepFrame(1));
els.fpsSlider.addEventListener('input', () => {
  state.fps = Number(els.fpsSlider.value);
  els.fpsValue.textContent = String(state.fps);
  if (state.selected?.animation) state.selected.animation.fps = state.fps;
});
els.overlayToggle.addEventListener('change', () => {
  state.overlays = els.overlayToggle.checked;
  draw();
});

requestAnimationFrame(tick);

async function loadAssets() {
  const token = els.tokenInput.value.trim();
  localStorage.setItem('asset_gen_token', token);
  const response = await fetch('/v1/assets/index', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    setDetails({ error: `${response.status} ${await response.text()}` });
    return;
  }
  const body = await response.json();
  state.assets = Array.isArray(body.assets) ? body.assets : [];
  applyFilter();
}

function applyFilter() {
  const query = els.filterInput.value.trim().toLowerCase();
  const playable = state.assets.filter((asset) => asset.animation);
  state.filtered = playable.filter((asset) => {
    const haystack = [
      asset.assetId,
      asset.request?.gameObject?.id,
      asset.family?.familyId,
      asset.family?.baseAssetId,
      asset.animation?.action,
    ].filter(Boolean).join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });

  els.assetCount.textContent = `${state.filtered.length}/${playable.length}`;
  els.assetSelect.replaceChildren(...state.filtered.map((asset) => {
    const option = document.createElement('option');
    option.value = asset.assetId;
    option.textContent = `${asset.animation.action} ${asset.animation.frameCount}f | ${asset.request?.gameObject?.id ?? asset.assetId}`;
    return option;
  }));

  if (state.filtered.length > 0) {
    els.assetSelect.value = state.filtered[0].assetId;
    void selectCurrent();
  } else {
    state.selected = null;
    draw();
    setDetails({ message: 'No animation assets found.' });
  }
}

async function selectCurrent() {
  const asset = state.filtered.find((entry) => entry.assetId === els.assetSelect.value);
  if (!asset) return;

  state.selected = asset;
  state.frameIndex = 0;
  state.fps = asset.animation?.fps ?? 8;
  els.fpsSlider.value = String(state.fps);
  els.fpsValue.textContent = String(state.fps);
  state.selectedImage = await loadImage(assetUrl(asset.urls.png));
  const baseAsset = state.assets.find((entry) => entry.assetId === asset.family?.baseAssetId);
  state.baseImage = baseAsset ? await loadImage(assetUrl(baseAsset.urls.png)) : null;
  draw();
  drawBase();
  updateDetails();
}

function tick(time) {
  if (state.lastTime === 0) state.lastTime = time;
  const delta = time - state.lastTime;
  state.lastTime = time;

  const frameCount = state.selected?.animation?.frameCount ?? 1;
  if (state.playing && frameCount > 1) {
    state.accumulator += delta;
    const frameMs = 1000 / Math.max(1, state.fps);
    while (state.accumulator >= frameMs) {
      state.accumulator -= frameMs;
      state.frameIndex = (state.frameIndex + 1) % frameCount;
      draw();
      updateDetails();
    }
  }

  requestAnimationFrame(tick);
}

function stepFrame(direction) {
  const frameCount = state.selected?.animation?.frameCount ?? 1;
  state.frameIndex = (state.frameIndex + direction + frameCount) % frameCount;
  state.accumulator = 0;
  draw();
  updateDetails();
}

function draw() {
  const canvas = els.stageCanvas;
  const ctx = stageCtx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0b08';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const asset = state.selected;
  const image = state.selectedImage;
  if (!asset || !image || !asset.animation) return;

  const frame = asset.animation.frames[state.frameIndex];
  const scale = Math.floor(Math.min(
    canvas.width / asset.animation.frameWidth,
    canvas.height / asset.animation.frameHeight
  ) * 0.78);
  const drawW = asset.animation.frameWidth * scale;
  const drawH = asset.animation.frameHeight * scale;
  const dx = Math.floor((canvas.width - drawW) / 2);
  const dy = Math.floor((canvas.height - drawH) / 2);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, dx, dy, drawW, drawH);

  if (state.overlays) {
    drawOverlays(ctx, frame, dx, dy, scale);
  }
}

function drawOverlays(ctx, frame, dx, dy, scale) {
  const bounds = frame.opaqueBounds;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d7f75b';
  ctx.strokeRect(
    dx + bounds.x * scale,
    dy + bounds.y * scale,
    bounds.w * scale,
    bounds.h * scale
  );

  const anchorX = dx + frame.anchor.x * frame.w * scale;
  const anchorY = dy + frame.anchor.y * frame.h * scale;
  ctx.strokeStyle = '#ff8a3d';
  ctx.beginPath();
  ctx.moveTo(anchorX - 12, anchorY);
  ctx.lineTo(anchorX + 12, anchorY);
  ctx.moveTo(anchorX, anchorY - 12);
  ctx.lineTo(anchorX, anchorY + 12);
  ctx.stroke();
  ctx.restore();
}

function drawBase() {
  const canvas = els.baseCanvas;
  const ctx = baseCtx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0d0f0b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.baseImage) return;
  const scale = Math.floor(Math.min(canvas.width / state.baseImage.width, canvas.height / state.baseImage.height) * 0.78);
  const w = state.baseImage.width * scale;
  const h = state.baseImage.height * scale;
  ctx.drawImage(state.baseImage, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function updateDetails() {
  const asset = state.selected;
  const frame = asset?.animation?.frames[state.frameIndex];
  if (!asset || !frame) return;
  els.frameLabel.textContent = frame.name;
  setDetails({
    assetId: asset.assetId,
    action: asset.animation.action,
    fps: state.fps,
    frame: `${state.frameIndex + 1}/${asset.animation.frameCount}`,
    familyId: asset.family?.familyId,
    baseAssetId: asset.family?.baseAssetId ?? '-',
    sourceModel: asset.family?.sourceModel,
    minIoU: asset.verification?.metrics?.minSilhouetteIoU,
    maxPalette: asset.verification?.metrics?.maxPaletteDistance,
    maxDrift: asset.verification?.metrics?.maxCenterDriftPx,
    areaRatio: asset.verification?.metrics?.minAreaRatio,
    frameIoU: frame.similarity?.silhouetteIoU,
    framePalette: frame.similarity?.paletteDistance,
    frameDrift: frame.similarity?.centerDriftPx,
  });
}

function setDetails(values) {
  els.details.replaceChildren(...Object.entries(values).flatMap(([key, value]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = key;
    dd.textContent = formatValue(value);
    return [dt, dd];
  }));
}

function formatValue(value) {
  if (typeof value === 'number') return Number(value.toFixed(3)).toString();
  if (value === undefined || value === null) return '-';
  return String(value);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function assetUrl(src) {
  try {
    const url = new URL(src, window.location.origin);
    return url.pathname;
  } catch {
    return src;
  }
}

void loadAssets();
