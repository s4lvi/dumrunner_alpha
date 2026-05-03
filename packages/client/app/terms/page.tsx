import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service · DÛM RUNNER',
};

export default function TermsPage() {
  return (
    <main className="min-h-screen px-6 py-16 max-w-3xl mx-auto text-zinc-200">
      <Link
        href="/"
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
        ← Back
      </Link>
      <h1 className="text-4xl font-bold mt-6 mb-2">Terms of Service</h1>
      <p className="text-sm text-zinc-500 mb-10">Effective: 2026-05-03</p>

      <section className="space-y-4 leading-relaxed">
        <p>
          DÛM RUNNER (&ldquo;the Game,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a browser-based
          multiplayer game in alpha development, operated by the DÛM RUNNER project
          maintainer. By creating an account, signing in with Discord, or otherwise
          accessing the Game, you agree to these Terms.
        </p>

        <h2 className="text-2xl font-semibold mt-8">1. Alpha software</h2>
        <p>
          The Game is pre-release software. It may contain bugs, change without notice,
          lose progress, or be taken offline at any time. Worlds, characters, inventories,
          and any other in-game state may be wiped between releases. Do not rely on
          progress persistence.
        </p>

        <h2 className="text-2xl font-semibold mt-8">2. Eligibility &amp; accounts</h2>
        <p>
          You must be at least 13 years old (16 in the EEA / UK) to use the Game.
          You are responsible for keeping your login credentials confidential and for all
          activity that occurs under your account. One person, one account; do not share
          accounts or use another player&rsquo;s credentials.
        </p>

        <h2 className="text-2xl font-semibold mt-8">3. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Cheat, exploit bugs for unfair advantage, or modify the client to bypass server-authoritative checks.</li>
          <li>Run automated bots, scrapers, or load-generators against the Game&rsquo;s servers.</li>
          <li>Harass, threaten, or send unlawful content to other players via in-game chat or any other channel.</li>
          <li>Reverse-engineer the service to extract secrets, impersonate the operator, or attack the infrastructure.</li>
          <li>Use the Game in any way that violates Discord&rsquo;s Terms of Service or Community Guidelines when launched as a Discord Activity.</li>
        </ul>
        <p>
          We may suspend or terminate access at any time for any reason, including suspected
          violations of these Terms.
        </p>

        <h2 className="text-2xl font-semibold mt-8">4. User content</h2>
        <p>
          &ldquo;User content&rdquo; means anything you submit through the Game, including display
          names, chat messages, server names, and gameplay actions. You retain ownership of
          your user content, and grant us a worldwide, royalty-free, non-exclusive license to
          host, store, transmit, and display it solely to operate the Game. You are
          responsible for the legality of what you submit.
        </p>

        <h2 className="text-2xl font-semibold mt-8">5. Discord integration</h2>
        <p>
          You can sign in via Discord OAuth and launch the Game as a Discord Activity. Use of
          those features is also governed by Discord&rsquo;s Terms of Service and Privacy Policy.
          See our <Link href="/privacy" className="underline">Privacy Policy</Link> for what
          information we receive from Discord.
        </p>

        <h2 className="text-2xl font-semibold mt-8">6. Intellectual property</h2>
        <p>
          The Game&rsquo;s code, art, audio, and design are owned by the DÛM RUNNER project
          maintainer or licensed from their respective owners. Nothing in these Terms grants
          you any right or license except as expressly stated.
        </p>

        <h2 className="text-2xl font-semibold mt-8">7. No warranty; limitation of liability</h2>
        <p>
          The Game is provided &ldquo;as is,&rdquo; without warranties of any kind, express or
          implied. To the maximum extent permitted by law, we are not liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss
          of data, profits, or goodwill arising from your use of the Game.
        </p>

        <h2 className="text-2xl font-semibold mt-8">8. Termination</h2>
        <p>
          You may stop using the Game at any time. We may suspend or terminate your access at
          any time, with or without notice, including if you breach these Terms or if we
          discontinue the service. Sections that by their nature should survive termination
          (e.g. Sections 6, 7) will survive.
        </p>

        <h2 className="text-2xl font-semibold mt-8">9. Changes</h2>
        <p>
          We may update these Terms. The &ldquo;Effective&rdquo; date above reflects the current
          version. Continued use after a change means you accept the new Terms.
        </p>

        <h2 className="text-2xl font-semibold mt-8">10. Contact</h2>
        <p>
          Questions, account deletion requests, or legal notices:{' '}
          <a href="mailto:jordansalvi@gmail.com" className="underline">
            jordansalvi@gmail.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
