// Art audit + review endpoint (local editor tool, like the rest of
// /api/editor). GET returns every audited art slot merged with the
// human review verdicts; POST records approve/reject (with an
// optional note) into packages/asset_gen/art/review.json, which the
// art worker reads when picking jobs. Repo-writing dev tool — on a
// read-only deploy the POST fails and the GET degrades to whatever
// is bundled.

import { NextResponse, type NextRequest } from 'next/server';
import path from 'node:path';
import {
  auditArtSlots,
  buildArtSlots,
  loadArtDirection,
  loadReview,
  saveReview,
} from '@dumrunner/asset_gen/artManifest';

const TEXTURES_DIR = path.join(process.cwd(), 'public', 'textures');
const ART_DIR = path.join(process.cwd(), '..', 'asset_gen', 'art');
const DIRECTION_PATH = path.join(ART_DIR, 'direction.json');
const REVIEW_PATH = path.join(ART_DIR, 'review.json');

export async function GET(): Promise<NextResponse> {
  try {
    const direction = await loadArtDirection(DIRECTION_PATH);
    const [slots, review] = await Promise.all([
      buildArtSlots(direction),
      loadReview(REVIEW_PATH),
    ]);
    const audited = await auditArtSlots(slots, TEXTURES_DIR, direction);
    return NextResponse.json({
      slots: audited.map((s) => ({ ...s, review: review[s.key] ?? null })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    key?: string;
    verdict?: 'approved' | 'rejected' | 'clear';
    note?: string;
  } | null;
  if (!body?.key || !body.verdict) {
    return NextResponse.json({ error: 'key and verdict required' }, { status: 400 });
  }
  try {
    const review = await loadReview(REVIEW_PATH);
    if (body.verdict === 'clear') {
      delete review[body.key];
    } else {
      review[body.key] = {
        verdict: body.verdict,
        ...(body.note ? { note: body.note } : {}),
        at: new Date().toISOString(),
      };
    }
    await saveReview(REVIEW_PATH, review);
    return NextResponse.json({ ok: true, review: review[body.key] ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
