import { validateCrawlerPayload } from './crawler-payload.js';
import type { CrawlerPayload } from './dom-crawler.js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const json = (status: number, body: Record<string, unknown>): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/sitemap/update' || request.method !== 'POST') {
      return json(404, { error: 'Not found' });
    }

    const authorization = request.headers.get('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) return json(401, { error: 'Unauthorized' });
    const apiKey = match[1];

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: 'Invalid payload' });
    }
    if (!validateCrawlerPayload(payload)) return json(400, { error: 'Invalid payload' });
    const validated = payload as CrawlerPayload;

    try {
      const base = env.SUPABASE_URL.replace(/\/$/, '');
      const headers = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      };
      const siteResponse = await fetch(`${base}/rest/v1/sites?api_key=eq.${encodeURIComponent(apiKey)}&active=eq.true&select=id`, { headers });
      if (!siteResponse.ok) return json(500, { error: 'Internal server error' });
      const sites: unknown = await siteResponse.json();
      if (!Array.isArray(sites) || !sites[0] || typeof sites[0].id !== 'string') return json(401, { error: 'Unauthorized' });

      const siteId = sites[0].id;
      const upsert = await fetch(`${base}/rest/v1/navigation_maps?on_conflict=site_id,url`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ site_id: siteId, url: validated.url, payload: validated }),
      });
      if (!upsert.ok) return json(500, { error: 'Internal server error' });
      return json(200, { ok: true, url: validated.url, targets: validated.actions.length });
    } catch {
      return json(500, { error: 'Internal server error' });
    }
  },
};
