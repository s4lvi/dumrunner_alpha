import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DÛM RUNNER',
  description: 'Browser-based multiplayer tactical extraction shooter.',
};

// Without explicit viewport, mobile browsers render the page at
// desktop width and zoom out to fit — every modal/grid then reads
// as a postage-stamp. Pin to device-width so CSS breakpoints apply.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Don't lock zoom out — keep it at 1 by default but let the
  // player pinch to zoom if they need to read small text. Pixi
  // canvas handles its own scaling.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
