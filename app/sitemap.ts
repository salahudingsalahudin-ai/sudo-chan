import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: new URL('/', siteUrl).toString(), changeFrequency: 'monthly', priority: 1 },
    { url: new URL('/privacy', siteUrl).toString(), changeFrequency: 'yearly', priority: 0.3 },
  ];
}
