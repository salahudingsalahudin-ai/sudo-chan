import type { Metadata } from 'next';
import './globals.css';
import './journey.css';
import { SUDO_CHAN } from '@/content';

const description = 'Meet Sudo-chan, a thoughtful desktop companion for the hard parts of your work.';
export const metadata: Metadata = {
  applicationName: SUDO_CHAN,
  title: `${SUDO_CHAN} — A little closer, when it counts`,
  description,
  openGraph: { type: 'website', title: `${SUDO_CHAN} — A little closer, when it counts`, description, siteName: SUDO_CHAN },
  twitter: { card: 'summary', title: `${SUDO_CHAN} — A little closer, when it counts`, description },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body style={{fontFamily:'"Inter Tight", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'}}>{children}</body></html>; }
