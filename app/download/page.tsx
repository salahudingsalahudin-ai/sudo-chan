import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import DownloadExperience from '@/components/DownloadExperience';
import { RELEASE_PUBLISHED, RELEASES_LATEST_URL, content } from '@/content';
import { buildGuideRelease, type GuideRelease } from '@/lib/installGuide';
import { fetchLatestRelease } from '@/lib/releases';

const page = content.downloadPage;
const installTitle = 'Install Sudo-chan in 4 steps';

// The latest release is read from the GitHub API and cached for an hour.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${installTitle} | Sudo-chan`,
  description: page.metadataDescription,
  alternates: { canonical: '/download' },
  openGraph: { type: 'website', title: `${installTitle} | Sudo-chan`, description: page.metadataDescription, url: '/download' },
  twitter: { card: 'summary_large_image', title: `${installTitle} | Sudo-chan`, description: page.metadataDescription },
};

export default async function DownloadPage() {
  // Nothing goes live until the owner flips RELEASE_PUBLISHED in content.ts.
  if (!RELEASE_PUBLISHED) notFound();
  const latest = await fetchLatestRelease();
  const release: GuideRelease = buildGuideRelease(latest, RELEASES_LATEST_URL);
  return <DownloadExperience release={release} />;
}
