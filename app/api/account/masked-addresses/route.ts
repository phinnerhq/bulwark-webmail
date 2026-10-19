import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import {
  MaskedAddressError,
  createMaskedAddress,
  deleteMaskedAddress,
  getMaskedAddressConfig,
  listMaskedAddresses,
  normalizeLabel,
  resolveMaskedAddressContext,
  updateMaskedAddress,
  type MaskedAddressContext,
} from '@/lib/masked-addresses/server';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * /api/account/masked-addresses - the caller's masked addresses.
 *
 *   GET                                         list them
 *   POST   { label? }                           make a new one
 *   PATCH  { email, enabled?, label? }          turn one off or on, or relabel it
 *   DELETE ?email=                              remove one for good
 *
 * The caller is whoever the session in the request's cookie slot belongs to
 * (X-JMAP-Cookie-Slot); see lib/masked-addresses/server.ts.
 */
async function context(request: NextRequest): Promise<MaskedAddressContext | NextResponse> {
  await configManager.ensureLoaded();
  const config = getMaskedAddressConfig();
  // Not set up: as far as callers can tell, the route does not exist.
  if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const creds = await getStalwartCredentials(request);
  if (!creds) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  return resolveMaskedAddressContext(creds, config);
}

async function handle(request: NextRequest, run: (ctx: MaskedAddressContext) => Promise<unknown>): Promise<NextResponse> {
  try {
    const ctx = await context(request);
    if (ctx instanceof NextResponse) return ctx;
    return NextResponse.json(await run(ctx), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MaskedAddressError) {
      if (error.status >= 500) logger.warn('Masked addresses: mail server problem', { code: error.code, error: error.message });
      return NextResponse.json({ error: error.code }, { status: error.status, headers: NO_STORE });
    }
    logger.error('Masked addresses failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
  }
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest) {
  return handle(request, async (ctx) => ({
    domain: ctx.config.domain,
    limit: ctx.config.limit,
    masks: await listMaskedAddresses(ctx),
  }));
}

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const body = await readBody(request);
  return handle(request, async (ctx) => ({ mask: await createMaskedAddress(ctx, normalizeLabel(body.label)) }));
}

export async function PATCH(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const body = await readBody(request);
  const changes = {
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    ...('label' in body ? { label: normalizeLabel(body.label) } : {}),
  };
  return handle(request, async (ctx) => ({ mask: await updateMaskedAddress(ctx, body.email, changes) }));
}

export async function DELETE(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const email = request.nextUrl.searchParams.get('email');
  return handle(request, async (ctx) => {
    await deleteMaskedAddress(ctx, email);
    return { ok: true };
  });
}
