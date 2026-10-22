const FALLBACK_SITE_URL = 'https://sudo-chan.vercel.app';

function getSiteUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!configuredUrl) return new URL(FALLBACK_SITE_URL);

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return new URL(FALLBACK_SITE_URL);
    return url;
  } catch {
    return new URL(FALLBACK_SITE_URL);
  }
}

export const siteUrl = getSiteUrl();
