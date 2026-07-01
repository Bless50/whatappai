import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { POST } from './route';

const mockFindOrCreateContact = vi.fn();
const mockSetContactTags = vi.fn();
const mockGetContactById = vi.fn();
const mockResolveAuditUserId = vi.fn();

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    supabase: {} as unknown as SupabaseClient,
    accountId: 'mock-account-id',
  })),
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api/v1/contacts')>();
  return {
    ...original,
    findOrCreateContact: (...args: unknown[]) => mockFindOrCreateContact(...args),
    setContactTags: (...args: unknown[]) => mockSetContactTags(...args),
    getContactById: (...args: unknown[]) => mockGetContactById(...args),
    resolveAuditUserId: (...args: unknown[]) => mockResolveAuditUserId(...args),
  };
});

describe('POST /api/v1/contacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuditUserId.mockResolvedValue('mock-user-id');
    mockFindOrCreateContact.mockResolvedValue({ id: 'contact-id', created: true });
    mockGetContactById.mockResolvedValue({
      id: 'contact-id',
      phone: '+14155550123',
      name: 'John Doe',
      email: null,
      company: null,
      avatar_url: null,
      tags: [],
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
    });
  });

  it('rejects a request with missing phone with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
  });

  it('creates contact successfully with valid request and no tags', async () => {
    const res = await POST(
      new Request('http://localhost/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14155550123' }),
      })
    );
    expect(res.status).toBe(201);
    expect(mockFindOrCreateContact).toHaveBeenCalled();
    expect(mockSetContactTags).not.toHaveBeenCalled();
  });

  it('rejects a request with malformed tags (string) with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14155550123', tags: 'invalid-tag-format' }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('must be an array of strings');
    expect(mockFindOrCreateContact).not.toHaveBeenCalled();
  });

  it('rejects a request with malformed tags (array of non-strings) with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14155550123', tags: ['valid-tag', 123] }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('must be an array of strings');
    expect(mockFindOrCreateContact).not.toHaveBeenCalled();
  });

  it('creates contact successfully with valid tags', async () => {
    const res = await POST(
      new Request('http://localhost/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+14155550123', tags: ['vip', 'lead'] }),
      })
    );
    expect(res.status).toBe(201);
    expect(mockFindOrCreateContact).toHaveBeenCalled();
    expect(mockSetContactTags).toHaveBeenCalledWith(
      expect.anything(),
      'mock-account-id',
      'mock-user-id',
      'contact-id',
      ['vip', 'lead']
    );
  });
});
