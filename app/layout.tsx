import type { Metadata } from 'next';
import './globals.css';
import './journey.css';
import './upgrade.css';
import { content, SUDO_CHAN } from '@/content';
import { siteUrl } from '@/lib/site';

const themeInitScript = `try{var saved=localStorage.getItem('sudo-chan-theme');document.documentElement.dataset.theme=saved==='dark'||saved==='light'?saved:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`;

const description = content.siteDescription;
export const metadata: Metadata = {
  metadataBase: siteUrl,
  applicationName: SUDO_CHAN,
  title: content.homeTitle,
  description,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    title: content.homeTitle,
    description,
    siteName: SUDO_CHAN,
    url: '/',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: content.openGraphImage.alt }],
  },
  twitter: {
    card: 'summary_large_image',
    title: content.homeTitle,
    description,
    images: ['/opengraph-image'],
  },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }}/></head>
    <body>{children}</body>
  </html>;
}
