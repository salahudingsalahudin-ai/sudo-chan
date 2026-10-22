import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}));

import { POST } from '../app/api/waitlist/route';

function makeRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/waitlist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.12',
      ...headers,
    },
    body,
  });
}

async function result(response: Response) {
  return {
    status: response.status,
    body: await response.json() as { ok: boolean; message: string },
  };
}

describe('POST /api/waitlist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://supabase.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.RATE_LIMIT_SALT = 'test-rate-limit-salt';
    mocks.rpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    mocks.insert.mockResolvedValue({ error: null });
    mocks.from.mockReturnValue({ insert: mocks.insert });
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  });

  it('accepts and normalizes a valid email', async () => {
    const response = await POST(makeRequest(JSON.stringify({ email: '  Person@Example.com  ' })));

    expect(await result(response)).toMatchObject({ status: 200, body: { ok: true } });
    expect(mocks.rpc).toHaveBeenCalledWith('consume_waitlist_attempt', {
      p_ip_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_limit: 5,
      p_window_seconds: 3600,
    });
    expect(mocks.from).toHaveBeenCalledWith('waitlist');
    expect(mocks.insert).toHaveBeenCalledWith({ email: 'person@example.com' });
    expect(mocks.rpc.mock.calls[0][1].p_ip_hash).not.toContain('203.0.113.12');
  });

  it('returns a duplicate response for an email already on the list', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '23505' } });

    const response = await POST(makeRequest(JSON.stringify({ email: 'person@example.com' })));

    expect(await result(response)).toMatchObject({
      status: 409,
      body: { ok: false, message: "You're already on the list." },
    });
  });

  it('rejects an invalid email before contacting Supabase', async () => {
    const response = await POST(makeRequest(JSON.stringify({ email: 'not-an-email' })));

    expect(await result(response)).toMatchObject({ status: 400, body: { ok: false } });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('rejects attempts after the per-IP limit is reached', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ allowed: false }], error: null });

    const response = await POST(makeRequest(JSON.stringify({ email: 'person@example.com' })));

    expect(await result(response)).toMatchObject({
      status: 429,
      body: { ok: false, message: 'You’ve reached the signup limit. Please try again in about an hour.' },
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('fails closed with a clear log when the rate-limit salt is missing', async () => {
    delete process.env.RATE_LIMIT_SALT;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(makeRequest(JSON.stringify({ email: 'person@example.com' })));

    expect(await result(response)).toMatchObject({ status: 503, body: { ok: false } });
    expect(log).toHaveBeenCalledWith('[waitlist] RATE_LIMIT_SALT is not configured; waitlist submissions are disabled.');
    expect(mocks.createClient).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('returns a friendly response when Supabase fails', async () => {
    mocks.insert.mockResolvedValue({ error: { code: 'XX000' } });

    const response = await POST(makeRequest(JSON.stringify({ email: 'person@example.com' })));

    expect(await result(response)).toMatchObject({ status: 500, body: { ok: false } });
  });

  it('rejects an oversized request body', async () => {
    const response = await POST(makeRequest(JSON.stringify({ email: 'a'.repeat(3000) })));

    expect(await result(response)).toMatchObject({ status: 413, body: { ok: false } });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
