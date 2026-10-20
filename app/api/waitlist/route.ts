import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const WINDOW_MS = 60_000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RateLimitBucket = { startedAt: number; count: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function response(ok: boolean, message: string, status: number) {
  return NextResponse.json({ ok, message }, { status });
}

function logFailure(message: string, code?: string) {
  try {
    if (code) console.error(`[waitlist] ${message} (${code})`);
    else console.error(`[waitlist] ${message}`);
  } catch {
    // Logging must not prevent the API from returning its response.
  }
}

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

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return response(false, 'Please enter a valid email address.', 400);
    }

    const submittedEmail = typeof body === 'object' && body !== null && 'email' in body
      ? (body as { email?: unknown }).email
      : undefined;

    if (typeof submittedEmail !== 'string') {
      return response(false, 'Please enter a valid email address.', 400);
    }

    const email = submittedEmail.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return response(false, 'Please enter a valid email address.', 400);
    }

    if (isRateLimited(getClientIp(request))) {
      return response(false, 'Too many attempts. Please try again in a minute.', 429);
    }

    const { error } = await getSupabase().from('waitlist').insert({ email });

    if (error?.code === '23505') {
      return response(false, "You're already on the list.", 409);
    }

    if (error) {
      logFailure('Supabase insert failed.', error.code);
      return response(false, "We couldn't add you right now. Please try again shortly.", 500);
    }

    return response(true, "You're on the list. We'll be in touch soon.", 200);
  } catch {
    logFailure('Unexpected waitlist server error.');
    return response(false, "We couldn't add you right now. Please try again shortly.", 500);
  }
}
