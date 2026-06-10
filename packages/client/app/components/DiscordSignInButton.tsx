export function DiscordSignInButton({ label = 'Continue with Discord' }: { label?: string }) {
  return (
    <>
      <a
        href="/api/auth/discord/start"
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-[#5865F2] text-white font-semibold hover:bg-[#4752c4] transition-colors"
      >
        <svg
          width="18"
          height="14"
          viewBox="0 0 71 55"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M60.1 4.9A58.6 58.6 0 0 0 45.6.5a.2.2 0 0 0-.2.1 40.6 40.6 0 0 0-1.8 3.7 54.1 54.1 0 0 0-16.3 0A37.3 37.3 0 0 0 25.4.6a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.7 5a.2.2 0 0 0-.1.1C1.6 18.7-.9 32 .3 45.2c0 .1.1.1.2.2a59 59 0 0 0 17.8 9 .2.2 0 0 0 .3-.1c1.4-1.9 2.6-3.9 3.7-6 0-.1 0-.2-.1-.3a39 39 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.8a.2.2 0 0 1 .2 0 42.2 42.2 0 0 0 35.7 0 .2.2 0 0 1 .2 0l1.1.8a.2.2 0 0 1 0 .4 36.6 36.6 0 0 1-5.5 2.6.2.2 0 0 0-.1.3c1.1 2.1 2.3 4.1 3.7 6 0 .1.2.2.3.1a58.8 58.8 0 0 0 17.8-9c.1 0 .2-.1.2-.2 1.5-15.3-2.4-28.4-10.4-40.2a.2.2 0 0 0-.1-.1ZM23.7 37.2c-3.5 0-6.4-3.2-6.4-7.1 0-4 2.8-7.2 6.4-7.2 3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.1-6.4 7.1Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.1 0-4 2.8-7.2 6.4-7.2 3.6 0 6.5 3.2 6.4 7.2 0 4-2.8 7.1-6.4 7.1Z" />
        </svg>
        {label}
      </a>
      <div className="my-4 flex items-center gap-3 text-xs text-zinc-500">
        <div className="flex-1 h-px bg-[color:var(--panel-border)]" />
        or
        <div className="flex-1 h-px bg-[color:var(--panel-border)]" />
      </div>
    </>
  );
}
