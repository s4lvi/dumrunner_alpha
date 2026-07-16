import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { AppNav } from '@/app/components/AppNav';
import { MissionControl, type ServerRow } from './MissionControl';

export const dynamic = 'force-dynamic';

const NOTICE_MESSAGES: Record<string, string> = {
  server_paused:
    'The server you were on was paused by its owner. Rejoin (as owner) or wait for them to resume.',
};

export default async function ServersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const noticeKey = typeof sp.notice === 'string' ? sp.notice : null;
  const notice = noticeKey ? NOTICE_MESSAGES[noticeKey] ?? null : null;

  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // world_status/world_status_at are absent until migration 0013 is
  // applied — select the legacy columns separately so a missing
  // column doesn't blank the whole browser.
  const base =
    'id, name, visibility, max_slots, owner_id, created_at, has_password, is_paused, mode, arena_scene_id, player_count';
  const { data, error } = await supabase
    .from('servers_public')
    .select(`${base}, world_status, world_status_at`)
    .order('created_at', { ascending: false });
  let servers: unknown[] = data ?? [];
  if (error) {
    const fallback = await supabase
      .from('servers_public')
      .select(base)
      .order('created_at', { ascending: false });
    servers = fallback.data ?? [];
  }

  const list = (servers as Partial<ServerRow>[]).map((s) => ({
    world_status: null,
    world_status_at: null,
    ...s,
  })) as ServerRow[];

  return (
    <>
      <AppNav />
      <MissionControl servers={list} currentUserId={user.id} notice={notice} />
    </>
  );
}
