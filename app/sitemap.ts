import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';
import { RELEASE_PUBLISHED } from '@/content';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: new URL('/', siteUrl).toString(), changeFrequency: 'monthly', priority: 1 },
    ...(RELEASE_PUBLISHED ? [{ url: new URL('/download', siteUrl).toString(), changeFrequency: 'weekly' as const, priority: 0.6 }] : []),
    { url: new URL('/privacy', siteUrl).toString(), changeFrequency: 'yearly', priority: 0.3 },
  ];
}
