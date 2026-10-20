import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const WINDOW_MS = 60_000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RateLimitBucket = { startedAt: number; count: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function isRateLimited(ip: string, now = Date.now()) {
  for (const [key, bucket] of Array.from(rateLimitBuckets.entries())) {
    if (now - bucket.startedAt >= WINDOW_MS) rateLimitBuckets.delete(key);
  }

  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    rateLimitBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }

  if (bucket.count >= MAX_SUBMISSIONS_PER_WINDOW) return true;
  bucket.count += 1;
  return false;
}

function getClientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Supabase server environment is not configured.');

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function json(message: string, status: number) {
  return Response.json({ message }, { status });
}

export async function POST(request: Request) {
  let email: string;

  try {
    const body: unknown = await request.json();
    const submittedEmail = typeof body === 'object' && body !== null && 'email' in body
      ? (body as { email?: unknown }).email
      : undefined;

    if (typeof submittedEmail !== 'string') {
      return json('Please enter a valid email address.', 400);
    }

    email = submittedEmail.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return json('Please enter a valid email address.', 400);
    }
  } catch {
    return json('Please enter a valid email address.', 400);
  }

  if (isRateLimited(getClientIp(request))) {
    return json('Too many attempts. Please try again in a minute.', 429);
  }

  try {
    const { error } = await getSupabase().from('waitlist').insert({ email });

    if (error?.code === '23505') {
      return json("You're already on the list.", 409);
    }
    if (error) {
      console.error('[waitlist] Supabase insert failed.');
      return json("We couldn't add you right now. Please try again shortly.", 500);
    }

    return json("You're on the list. We'll be in touch soon.", 201);
  } catch {
    console.error('[waitlist] Request failed because Supabase is unavailable or misconfigured.');
    return json("We couldn't add you right now. Please try again shortly.", 500);
  }
}
