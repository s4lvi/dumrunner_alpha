import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { serverEnv } from '../env';
import { supabaseAdmin } from '../supabase/admin';

// Synthetic-email Supabase auth path for Discord users. Each Discord
// identity gets a deterministic email + password derived from the
// Discord subject (`id` from /users/@me) and the JOIN_TOKEN_SECRET.
// First sight provisions the auth.users + accounts row; subsequent
// sights just refresh `discord_username` / `discord_avatar` and
// return existing creds. The caller signs the user in with
// `signInWithPassword` to set the session cookies.
//
// Why synthetic email and not a self-issued JWT: the rest of the app
// (server-side join, RLS policies, /servers list) keys off the
// Supabase session. Going JWT means rewiring all of that. Synthetic
// email keeps Discord users on the same code path as email users
// without leaking the synthetic email anywhere user-visible.

export type DiscordProfile = {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
};

const SYNTHETIC_EMAIL_DOMAIN = 'discord.dumrunner.local';

function syntheticEmail(discordId: string): string {
  return `${discordId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

function syntheticPassword(discordId: string): string {
  // Deterministic so we can re-sign-in later without storing the
  // password anywhere. HMAC over the secret means you can't derive it
  // from the discord id alone.
  return createHmac('sha256', serverEnv.joinTokenSecret())
    .update(`discord:${discordId}`)
    .digest('hex');
}

function deriveDisplayName(profile: DiscordProfile): string {
  const raw = profile.global_name?.trim() || profile.username.trim() || 'runner';
  return raw.slice(0, 32);
}

export type DiscordExchangeResult = {
  profile: DiscordProfile;
  accessToken: string;
};

// Exchange the OAuth `code` for an access token, then fetch the user
// profile. `flow: 'web'` includes the registered redirect_uri (web
// OAuth login). `flow: 'activity'` omits it — the Discord embedded
// SDK handles the redirect host internally and Discord rejects the
// exchange if a redirect_uri is sent.
export async function exchangeDiscordCode(
  code: string,
  flow: 'web' | 'activity'
): Promise<DiscordExchangeResult | null> {
  const params = new URLSearchParams({
    client_id: serverEnv.discordClientId(),
    client_secret: serverEnv.discordClientSecret(),
    grant_type: 'authorization_code',
    code,
  });
  if (flow === 'web') {
    params.set('redirect_uri', serverEnv.discordRedirectUri());
  }
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    cache: 'no-store',
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    console.error('[discord] token_exchange_failed', flow, tokenRes.status, detail);
    return null;
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return null;

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
    cache: 'no-store',
  });
  if (!meRes.ok) {
    console.error('[discord] users_me_failed', meRes.status);
    return null;
  }
  const me = (await meRes.json()) as DiscordProfile;
  if (!me.id) return null;
  return { profile: me, accessToken: tokenJson.access_token };
}

// Provision (or look up) the Supabase auth user + accounts row for
// this Discord identity, then return the synthetic credentials the
// caller should pass to signInWithPassword.
export async function provisionDiscordSession(profile: DiscordProfile): Promise<{
  email: string;
  password: string;
  displayName: string;
}> {
  const admin = supabaseAdmin();
  const email = syntheticEmail(profile.id);
  const password = syntheticPassword(profile.id);
  const displayName = deriveDisplayName(profile);

  // Check if accounts already has this discord_sub. If yes, we may
  // still need to ensure auth.users exists (defensive against partial
  // provisions from earlier failures).
  const { data: existingAccount } = await admin
    .from('accounts')
    .select('id, display_name')
    .eq('discord_sub', profile.id)
    .maybeSingle();

  let userId: string | null = existingAccount?.id ?? null;

  if (!userId) {
    // Try to create the auth user. If they already exist (synthetic
    // email collision from a prior partial run), fall through to the
    // lookup branch.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { provider: 'discord', discord_sub: profile.id },
    });
    if (createErr && !/already (registered|exists)/i.test(createErr.message)) {
      throw new Error(`discord_user_provision_failed: ${createErr.message}`);
    }
    if (created?.user) {
      userId = created.user.id;
    }
  }

  if (!userId) {
    // Either the account row had no auth user (broken state) or the
    // createUser call hit "already exists". Resolve via listUsers.
    // Supabase's admin API doesn't expose a direct "find by email"
    // helper, so we paginate the first page and filter.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
    const match = list?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
      throw new Error('discord_user_lookup_failed');
    }
    userId = match.id;
    // Re-set the password to the deterministic value so the
    // subsequent signInWithPassword works regardless of what the row
    // had before.
    await admin.auth.admin.updateUserById(userId, { password });
  }

  // Upsert the accounts row.
  const accountPatch = {
    id: userId,
    display_name: existingAccount?.display_name ?? displayName,
    discord_sub: profile.id,
    discord_username: profile.username,
    discord_avatar: profile.avatar,
  };
  const { error: upsertErr } = await admin
    .from('accounts')
    .upsert(accountPatch, { onConflict: 'id' });
  if (upsertErr) {
    throw new Error(`discord_account_upsert_failed: ${upsertErr.message}`);
  }

  return {
    email,
    password,
    displayName: accountPatch.display_name,
  };
}

// CSRF state for the OAuth round-trip. Stored in a short-lived
// http-only cookie; we compare-equal on the callback.
export function makeOauthState(): string {
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 32);
}
