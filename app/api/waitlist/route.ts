import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_REQUEST_BODY_BYTES = 2 * 1024;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const SUPABASE_TIMEOUT_MS = 5_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOO_LARGE_MESSAGE = 'That request is too large. Please check your email and try again.';
const TEMPORARY_ERROR_MESSAGE = "We couldn't add you right now. Please try again shortly.";

class RequestBodyTooLargeError extends Error {}

function response(ok: boolean, message: string, status: number) {
  return NextResponse.json({ ok, message }, { status });
}

function logFailure(message: string, code?: string) {
  console.error(code ? `[waitlist] ${message} (${code})` : `[waitlist] ${message}`);
}

function errorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

async function readRequestBody(request: Request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0) {
      throw new Error('Invalid content length.');
    }
    if (declaredLength > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is empty.');

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          logFailure('Oversized request body could not be cancelled.');
        }
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function getClientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
}

function hashClientIp(ip: string, salt: string) {
  return createHmac('sha256', salt).update(ip).digest('hex');
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Supabase server environment is not configured.');

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => {
        const timeoutSignal = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal;
        return fetch(input, { ...init, signal });
      },
    },
  });
}

export async function GET() {
  try {
    const { count, error } = await getSupabase()
      .from('waitlist')
      .select('*', { count: 'exact', head: true });

    if (error || count === null) {
      logFailure('Waitlist count query failed.', errorCode(error));
      return NextResponse.json(
        { count: null },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return NextResponse.json(
      { count },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logFailure('Unexpected waitlist count error.', errorCode(error));
    return NextResponse.json(
      { count: null },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return response(false, TOO_LARGE_MESSAGE, 413);
    }
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

  const salt = process.env.RATE_LIMIT_SALT;
  if (!salt) {
    logFailure('RATE_LIMIT_SALT is not configured; waitlist submissions are disabled.');
    return response(false, 'Signup is temporarily unavailable. Please try again shortly.', 503);
  }

  try {
    const supabase = getSupabase();
    const hashedIp = hashClientIp(getClientIp(request), salt);
    const { data: limitResult, error: limitError } = await supabase.rpc('consume_waitlist_attempt', {
      p_ip_hash: hashedIp,
      p_limit: MAX_ATTEMPTS_PER_WINDOW,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    });

    if (limitError) {
      logFailure('Waitlist rate-limit query failed.', errorCode(limitError));
      return response(false, 'Signup is temporarily unavailable. Please try again shortly.', 503);
    }

    const allowed = Array.isArray(limitResult)
      && limitResult.length === 1
      && typeof limitResult[0] === 'object'
      && limitResult[0] !== null
      && 'allowed' in limitResult[0]
      && limitResult[0].allowed === true;

    if (!allowed) {
      if (Array.isArray(limitResult) && limitResult.length === 1 && limitResult[0]?.allowed === false) {
        return response(false, 'You’ve reached the signup limit. Please try again in about an hour.', 429);
      }
      logFailure('Waitlist rate-limit query returned an invalid response.');
      return response(false, 'Signup is temporarily unavailable. Please try again shortly.', 503);
    }

    const { error } = await supabase.from('waitlist').insert({ email });
    if (error?.code === '23505') {
      return response(false, "You're already on the list.", 409);
    }
    if (error) {
      logFailure('Supabase insert failed.', errorCode(error));
      return response(false, TEMPORARY_ERROR_MESSAGE, 500);
    }

    return response(true, "You're on the list. We'll be in touch soon.", 200);
  } catch (error) {
    logFailure('Unexpected waitlist server error.', errorCode(error));
    return response(false, TEMPORARY_ERROR_MESSAGE, 500);
  }
}
