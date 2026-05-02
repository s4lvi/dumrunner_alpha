// Audio manager. Single module owns SFX preloading, polyphonic playback,
// looping music with crossfade, master volume + mute, and the
// browser-autoplay-policy unlock on first user gesture.
//
// Why HTMLAudioElement and not WebAudio? For an alpha SFX layer the
// added control of WebAudio (3D positioning, filters) isn't needed.
// HTMLAudioElement is simpler, debuggable in DevTools, and Pixi already
// owns the GPU. We can swap backends later without touching callers.

'use client';

type SfxId =
  | 'player-shoot'
  | 'player-hit'
  | 'player-footstep'
  | 'player-jump'
  | 'enemy-shoot'
  | 'robot-hit'
  | 'robot-destroy'
  | 'robot-detect'
  | 'collect-scrap'
  | 'collect-core'
  | 'ui-click'
  | 'ui-hover'
  | 'ui-back';

type MusicId = 'dungeon' | 'defense' | null;

const SFX_FILES: Record<SfxId, string> = {
  'player-shoot': '/sounds/player-shoot.mp3',
  'player-hit': '/sounds/player-hit.mp3',
  'player-footstep': '/sounds/player-footstep.mp3',
  'player-jump': '/sounds/player-jump.mp3',
  // Enemy weapon discharge — re-uses the player-shoot sample at a
  // lower per-sfx volume so it reads as "the same gun, but theirs."
  'enemy-shoot': '/sounds/player-shoot.mp3',
  'robot-hit': '/sounds/robot-hit.mp3',
  'robot-destroy': '/sounds/robot-destroy.mp3',
  'robot-detect': '/sounds/robot-detect.mp3',
  'collect-scrap': '/sounds/collect-scrap.mp3',
  'collect-core': '/sounds/collect-core.mp3',
  'ui-click': '/sounds/ui-click.mp3',
  'ui-hover': '/sounds/ui-hover.mp3',
  'ui-back': '/sounds/ui-back.mp3',
};

const MUSIC_FILES: Record<Exclude<MusicId, null>, string> = {
  dungeon: '/music/dungeon-theme.mp3',
  defense: '/music/defense-theme.mp3',
};

// Per-SFX gain so the louder samples don't clip the master. Tuned by ear
// against the included files; tweak if anything reads too hot.
const SFX_VOLUME: Partial<Record<SfxId, number>> = {
  'player-shoot': 0.45,
  'enemy-shoot': 0.3,
  'player-hit': 0.7,
  'player-footstep': 0.25,
  'robot-hit': 0.6,
  'robot-destroy': 0.7,
  'robot-detect': 0.5,
  'collect-scrap': 0.5,
  'collect-core': 0.7,
  'ui-click': 0.5,
  'ui-hover': 0.3,
  'ui-back': 0.5,
};

const STORAGE_VOLUME = 'dumrunner_audio_volume';
const STORAGE_MUTED = 'dumrunner_audio_muted';

class AudioManager {
  private sfxBuffers: Partial<Record<SfxId, HTMLAudioElement>> = {};
  // Pool of clones we cycle through so consecutive plays don't cut
  // each other off. Small per-id; SFX are short.
  private sfxPool: Partial<Record<SfxId, HTMLAudioElement[]>> = {};
  private sfxPoolCursor: Partial<Record<SfxId, number>> = {};
  private music: Map<Exclude<MusicId, null>, HTMLAudioElement> = new Map();
  private currentMusic: MusicId = null;
  private targetMusic: MusicId = null;
  private fadeRaf: number | null = null;

  private masterVolume = 0.7;
  private muted = false;
  private unlocked = false;
  private preloaded = false;

  constructor() {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem(STORAGE_VOLUME);
      if (v !== null) {
        const n = Number(v);
        if (Number.isFinite(n)) this.masterVolume = Math.max(0, Math.min(1, n));
      }
      const m = window.localStorage.getItem(STORAGE_MUTED);
      if (m === '1') this.muted = true;
    }
  }

  preload() {
    if (this.preloaded || typeof window === 'undefined') return;
    this.preloaded = true;
    for (const [id, src] of Object.entries(SFX_FILES) as [SfxId, string][]) {
      const a = new Audio(src);
      a.preload = 'auto';
      this.sfxBuffers[id] = a;
      // 4 clones is enough for fast-fire weapons; footstep + shoot are
      // the only events that overlap themselves.
      const POOL = 4;
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < POOL; i++) {
        const c = new Audio(src);
        c.preload = 'auto';
        pool.push(c);
      }
      this.sfxPool[id] = pool;
      this.sfxPoolCursor[id] = 0;
    }
    for (const [id, src] of Object.entries(MUSIC_FILES) as [
      Exclude<MusicId, null>,
      string,
    ][]) {
      const a = new Audio(src);
      a.preload = 'auto';
      a.loop = true;
      a.volume = 0;
      this.music.set(id, a);
    }
  }

  // Browsers refuse audio.play() until the user interacts. Call this on
  // the first click / keypress and we'll arm the music.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.applyMusicTarget();
  }

  setMasterVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_VOLUME, String(this.masterVolume));
    }
    this.applyMusicVolumeNow();
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_MUTED, m ? '1' : '0');
    }
    this.applyMusicVolumeNow();
  }

  isMuted(): boolean {
    return this.muted;
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // One-shot SFX. Picks the next free element from the pool (round-
  // robin) so consecutive shots layer instead of restarting.
  playSfx(id: SfxId) {
    if (typeof window === 'undefined') return;
    if (!this.preloaded) this.preload();
    const pool = this.sfxPool[id];
    if (!pool || pool.length === 0) return;
    const cursor = this.sfxPoolCursor[id] ?? 0;
    const a = pool[cursor];
    this.sfxPoolCursor[id] = (cursor + 1) % pool.length;
    a.currentTime = 0;
    a.volume = this.effectiveVolume(SFX_VOLUME[id] ?? 0.6);
    // play() returns a promise that rejects when blocked by autoplay
    // policy; swallow because we've usually unlocked by this point and
    // there's nothing useful to do.
    a.play().catch(() => {});
  }

  // Switch the looping background track. Crossfades the outgoing track
  // out and the incoming track in over ~600ms.
  playMusic(id: MusicId) {
    this.targetMusic = id;
    this.applyMusicTarget();
  }

  private applyMusicTarget() {
    if (!this.unlocked || typeof window === 'undefined') return;
    if (this.targetMusic === this.currentMusic && !this.fadeRaf) return;

    const fromId = this.currentMusic;
    const toId = this.targetMusic;
    this.currentMusic = toId;

    const from = fromId ? this.music.get(fromId) : null;
    const to = toId ? this.music.get(toId) : null;

    if (to) {
      to.currentTime = 0;
      to.volume = 0;
      to.play().catch(() => {});
    }

    const startedAt = performance.now();
    const FADE_MS = 600;
    const targetVol = this.effectiveMusicVolume();

    const tick = () => {
      const t = Math.min(1, (performance.now() - startedAt) / FADE_MS);
      if (from) from.volume = (1 - t) * targetVol;
      if (to) to.volume = t * targetVol;
      if (t < 1) {
        this.fadeRaf = requestAnimationFrame(tick);
        return;
      }
      this.fadeRaf = null;
      if (from) from.pause();
    };
    if (this.fadeRaf) cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = requestAnimationFrame(tick);
  }

  private applyMusicVolumeNow() {
    const v = this.effectiveMusicVolume();
    for (const [id, a] of this.music) {
      if (id === this.currentMusic && !this.fadeRaf) a.volume = v;
    }
  }

  private effectiveVolume(perSfx: number): number {
    if (this.muted) return 0;
    return this.masterVolume * perSfx;
  }

  private effectiveMusicVolume(): number {
    // Music sits noticeably under SFX so combat readouts stay clear.
    return this.muted ? 0 : this.masterVolume * 0.35;
  }
}

export const audio = new AudioManager();
export type { SfxId, MusicId };
