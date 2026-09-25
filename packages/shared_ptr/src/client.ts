/**
 * Typed HTTP client for a shared_ptr gatekeeper, generated from the contract:
 * every request is validated before it is sent and every response before it is
 * returned, so a version skew fails loudly instead of corrupting data.
 */
import { CONTRACT_VERSION, MetaResponse, ROUTES, routePath, type RoutePath } from '@shared_ptr/contract';
import { readOwnerToken } from '@shared_ptr/contract/local';
import type { z } from 'zod';
import { setting } from './env.js';

type Req<P extends RoutePath> = z.input<(typeof ROUTES)[P]['request']>;
type Res<P extends RoutePath> = z.output<(typeof ROUTES)[P]['response']>;

export class SharedPtrHttpError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, route: string) {
    super(`shared_ptr ${route} → HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    this.name = 'SharedPtrHttpError';
  }
}

/** Server URL: explicit, else SHARED_PTR_SERVER, else the legacy AGENTCTL_GATEWAY_URL. */
export function resolveServerUrl(explicit?: string | null): string | null {
  const url = explicit?.trim() || process.env.SHARED_PTR_SERVER?.trim() || setting('GATEWAY_URL')?.trim();
  return url || null;
}

/** Bearer token: SHARED_PTR_TOKEN, the legacy AGENTCTL_GATEWAY_TOKEN, else the local owner token (same machine). */
export function resolveToken(server: string): string | null {
  const explicit = process.env.SHARED_PTR_TOKEN?.trim() || setting('GATEWAY_TOKEN')?.trim();
  if (explicit) return explicit;
  const host = new URL(server).hostname;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) ? readOwnerToken() : null;
}

export class SharedPtrClient {
  constructor(private readonly server: string, private readonly token: string | null = resolveToken(server)) {
    const u = new URL(server);
    if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
      process.stderr.write(`shared_ptr: warning: ${server} uses plain http to a non-loopback host; your token travels unencrypted.\n`);
    }
  }

  async call<P extends RoutePath>(route: P, body: Req<P>): Promise<Res<P>> {
    const spec = ROUTES[route];
    const request = spec.request.parse(body) as Record<string, unknown>;
    const url = new URL(routePath(route), this.server);
    const headers: Record<string, string> = this.token ? { authorization: `Bearer ${this.token}` } : {};
    let res: Response;
    if (spec.method === 'GET') {
      for (const [k, v] of Object.entries(request)) if (v !== undefined) url.searchParams.set(k, String(v));
      res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    } else {
      res = await fetch(url, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(120_000),
      });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new SharedPtrHttpError(res.status, json, route);
    return spec.response.parse(json) as Res<P>;
  }

  /** Version handshake: throws when the server speaks another contract version. */
  async checkVersion(): Promise<string> {
    const res = await fetch(new URL('/v1/meta', this.server), { signal: AbortSignal.timeout(10_000) });
    const meta = MetaResponse.safeParse(await res.json().catch(() => null));
    if (!meta.success) throw new Error(`${this.server} is not a shared_ptr server (no /v1/meta)`);
    if (meta.data.contract_version !== CONTRACT_VERSION) {
      throw new Error(`${this.server} speaks contract v${meta.data.contract_version}; this client speaks v${CONTRACT_VERSION}`);
    }
    return meta.data.contract_version;
  }
}
