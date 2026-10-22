import type { Metadata } from 'next';
import Link from 'next/link';
import { content } from '@/content';

const privacy = content.privacyPage;

export const metadata: Metadata = {
  title: `${privacy.title} | Sudo-chan`,
  description: privacy.metadataDescription,
  alternates: { canonical: '/privacy' },
  openGraph: {
    type: 'website',
    title: `${privacy.title} | Sudo-chan`,
    description: privacy.metadataDescription,
    url: '/privacy',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${privacy.title} | Sudo-chan`,
    description: privacy.metadataDescription,
  },
};

export default function PrivacyPage() {
  return (
    <main className="privacy-page">
      <article className="privacy-page-content" aria-labelledby="privacy-title">
        <Link className="privacy-page-back" href="/">{privacy.backLink}</Link>
        <h1 id="privacy-title">{privacy.title}</h1>
        <p className="privacy-page-intro">{privacy.intro}</p>

        <section aria-labelledby="website-privacy-title">
          <h2 id="website-privacy-title">{privacy.websiteTitle}</h2>
          {privacy.websiteParagraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </section>

        <section aria-labelledby="planned-privacy-title">
          <h2 id="planned-privacy-title">{privacy.plannedTitle}</h2>
          <p className="privacy-page-notice">{privacy.plannedNotice}</p>
          {privacy.plannedParagraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </section>
      </article>
    </main>
  );
}
