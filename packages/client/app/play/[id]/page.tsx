import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { Game } from './Game';

export const dynamic = 'force-dynamic';

export default async function PlayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return <Game serverId={id} />;
}
