import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy · DÛM RUNNER',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen px-6 py-16 max-w-3xl mx-auto text-zinc-200">
      <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200">
        ← Back
      </Link>
      <h1 className="text-4xl font-bold mt-6 mb-2">Privacy Policy</h1>
      <p className="text-sm text-zinc-500 mb-10">Effective: 2026-05-03</p>

      <section className="space-y-4 leading-relaxed">
        <p>
          This policy describes what data DÛM RUNNER (&ldquo;the Game,&rdquo; &ldquo;we&rdquo;)
          collects, why we collect it, who we share it with, and the choices you have. We
          collect only what we need to run the Game.
        </p>

        <h2 className="text-2xl font-semibold mt-8">1. What we collect</h2>

        <h3 className="text-xl font-semibold mt-6">1.1 Account data</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Email sign-up:</strong> email address, hashed password, display name.</li>
          <li>
            <strong>Discord sign-in / Activity:</strong> when you authorise the Game with
            Discord (scope <code>identify</code>), Discord sends us your Discord user ID,
            username, global display name, and avatar hash. We do <em>not</em> request your
            Discord email, friend list, server list, or message history. We store the
            Discord user ID, username, and avatar hash; we do not store the OAuth access
            token after the sign-in flow completes.
          </li>
        </ul>

        <h3 className="text-xl font-semibold mt-6">1.2 Game state</h3>
        <ul className="list-disc pl-6 space-y-1">
          <li>Per-server character data: position, inventory, equipment, statistics.</li>
          <li>Server-membership data: which servers you have joined, who owns them, configuration of servers you create.</li>
          <li>In-game chat messages (server-wide), retained only in transient game-server memory and dropped when the server process restarts.</li>
        </ul>

        <h3 className="text-xl font-semibold mt-6">1.3 Discord Activity instance binding</h3>
        <p>
          When you launch the Game as a Discord Activity, we receive an{' '}
          <code>instance_id</code> from Discord that identifies the voice-call session. We
          store this id alongside the matching game-server row so everyone in the same call
          lands in the same world. We do not store anything else about the call (no voice
          data, no participant list beyond who actually launched the Activity into a game
          session).
        </p>

        <h3 className="text-xl font-semibold mt-6">1.4 Operational logs</h3>
        <p>
          Our hosting providers (Vercel, Fly.io, Supabase) keep short-lived request /
          connection logs containing IP address, user agent, and request metadata for
          security and debugging. We do not aggregate these into player profiles.
        </p>

        <h3 className="text-xl font-semibold mt-6">1.5 Cookies</h3>
        <p>
          We use only the cookies needed to run the Game: a Supabase session cookie that
          keeps you signed in, and a short-lived Discord OAuth state cookie used during
          sign-in to prevent CSRF. We do not use advertising or analytics cookies.
        </p>

        <h2 className="text-2xl font-semibold mt-8">2. Why we collect it</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>To create and authenticate your account.</li>
          <li>To run the multiplayer simulation server-authoritatively.</li>
          <li>To persist your character between sessions.</li>
          <li>To bind a Discord Activity to a game-server instance so you land in the right world.</li>
          <li>To investigate abuse, debug crashes, and protect the service.</li>
        </ul>

        <h2 className="text-2xl font-semibold mt-8">3. Who we share it with</h2>
        <p>We do not sell your data. We share it only with the infrastructure providers we use to run the Game:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Supabase</strong> — authentication and database (account rows, character rows, server rows).</li>
          <li><strong>Vercel</strong> — hosts the web app and API routes.</li>
          <li><strong>Fly.io</strong> — hosts the game-server processes.</li>
          <li><strong>Discord</strong> — only when you choose to use Discord sign-in or launch the Game as an Activity. We send Discord the OAuth code we receive and request your basic profile.</li>
          <li>
            <strong>OpenAI</strong> — our asset-generation pipeline sends generic, non-personal prompts (entity kind, biome, palette) to OpenAI&rsquo;s image API to generate sprite art. No account or player data is included in those prompts.
          </li>
        </ul>
        <p>
          We may also disclose data when required by law, to enforce these terms, or to
          protect the rights and safety of users and the public.
        </p>

        <h2 className="text-2xl font-semibold mt-8">4. Retention</h2>
        <p>
          We keep account and character data for as long as your account exists. If you ask
          us to delete your account (see §6), we delete your account row and the
          associated character rows. Operational logs at our infrastructure providers are
          retained according to those providers&rsquo; defaults (typically 30–90 days).
        </p>

        <h2 className="text-2xl font-semibold mt-8">5. Security</h2>
        <p>
          Passwords are hashed; we never store them in plaintext. Sessions use HTTP-only
          cookies. The game server validates every action server-side. No system is
          perfectly secure; please do not reuse passwords from other services.
        </p>

        <h2 className="text-2xl font-semibold mt-8">6. Your rights</h2>
        <p>
          You may request access to, correction of, or deletion of your personal data by
          emailing{' '}
          <a href="mailto:jordansalvi@gmail.com" className="underline">
            jordansalvi@gmail.com
          </a>
          . If you signed in with Discord, you can also revoke our access at any time from
          Discord&rsquo;s Authorized Apps settings; doing so will prevent future sign-ins but
          does not on its own delete your stored profile in DÛM RUNNER.
        </p>

        <h2 className="text-2xl font-semibold mt-8">7. Children</h2>
        <p>
          The Game is not directed to children under 13 (or under 16 in the EEA / UK). We
          do not knowingly collect data from children below those ages. If you believe a
          child has signed up, contact us and we will delete the account.
        </p>

        <h2 className="text-2xl font-semibold mt-8">8. International users</h2>
        <p>
          Your data may be stored and processed in regions where our infrastructure
          providers operate (primarily the United States). By using the Game you consent to
          this transfer.
        </p>

        <h2 className="text-2xl font-semibold mt-8">9. Changes</h2>
        <p>
          We may update this policy. The &ldquo;Effective&rdquo; date at the top reflects the
          current version. Material changes will be highlighted on the sign-in page.
        </p>

        <h2 className="text-2xl font-semibold mt-8">10. Contact</h2>
        <p>
          Questions or requests:{' '}
          <a href="mailto:jordansalvi@gmail.com" className="underline">
            jordansalvi@gmail.com
          </a>
          .
        </p>

        <p className="mt-10 text-sm text-zinc-500">
          See also our <Link href="/terms" className="underline">Terms of Service</Link>.
        </p>
      </section>
    </main>
  );
}
