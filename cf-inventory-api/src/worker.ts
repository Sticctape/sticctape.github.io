export interface Env {
  DB: D1Database;
  // IMAGES: R2Bucket; // future
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...init.headers });
  return new Response(JSON.stringify(data), { ...init, headers });
}

function withCORS(resp: Response) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*'); // TODO tighten to your site origin
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, X-Owner-Id, Authorization');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function corsPreflight(req: Request) {
  if (req.method === 'OPTIONS') {
    return withCORS(new Response(null, { status: 204 }));
  }
}

async function getOwnerId(req: Request): Promise<string> {
  // MVP: use a header to simulate auth. Replace with Cloudflare Access/JWT later.
  const header = req.headers.get('x-owner-id');
  if (header && header.length > 0) return header;
  // Fallback to a cookie or query param for dev, if needed
  const url = new URL(req.url);
  const qp = url.searchParams.get('owner');
  if (qp) return qp;
  throw new Error('Missing owner identity. Provide X-Owner-Id header for now.');
}

async function handleListBottles(request: Request, env: Env) {
  const ownerId = await getOwnerId(request);
  const url = new URL(request.url);
  const search = url.searchParams.get('search')?.trim();
  const base = url.searchParams.get('base_spirit')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const tag = url.searchParams.get('tag')?.trim();

  let sql = `SELECT b.* FROM bottles b`;
  const where: string[] = [`b.owner_id = ?`];
  const params: any[] = [ownerId];

  if (tag) {
    sql += ` JOIN bottle_tags bt ON bt.bottle_id = b.id JOIN tags t ON t.id = bt.tag_id AND t.owner_id = b.owner_id`;
    where.push(`t.name = ?`);
    params.push(tag);
  }
  if (search) {
    where.push(`(b.brand LIKE ? OR b.product_name LIKE ? OR b.style LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (base) { where.push(`b.base_spirit = ?`); params.push(base); }
  if (status) { where.push(`b.status = ?`); params.push(status); }

  sql += ` WHERE ${where.join(' AND ')} ORDER BY b.updated_at DESC LIMIT 500`;
  const rs = await env.DB.prepare(sql).bind(...params).all();
  return json({ bottles: rs.results });
}

async function handleCreateBottle(request: Request, env: Env) {
  const ownerId = await getOwnerId(request);
  const body = await request.json();
  const id = crypto.randomUUID();

  const {
    brand, product_name, base_spirit, style, abv, volume_ml, quantity = 1,
    status = 'sealed', purchase_date, price_cents, currency = 'USD', location, notes, image_url, tags
  } = body || {};

  if (!brand || !product_name) {
    return json({ error: 'brand and product_name are required' }, { status: 400 });
  }

  const stmt = env.DB.prepare(`INSERT INTO bottles (
    id, owner_id, brand, product_name, base_spirit, style, abv, volume_ml, quantity, status,
    purchase_date, price_cents, currency, location, notes, image_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(id, ownerId, brand, product_name, base_spirit, style, abv, volume_ml, quantity, status,
        purchase_date, price_cents, currency, location, notes, image_url);

  await stmt.run();

  if (Array.isArray(tags) && tags.length > 0) {
    for (const name of tags) {
      const tid = crypto.randomUUID();
      // upsert tag by (owner_id,name)
      const existing = await env.DB.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).bind(ownerId, name).first();
      const tagId = existing?.id || tid;
      if (!existing) {
        await env.DB.prepare(`INSERT INTO tags (id, owner_id, name) VALUES (?, ?, ?)`)
          .bind(tagId, ownerId, name).run();
      }
      await env.DB.prepare(`INSERT OR IGNORE INTO bottle_tags (bottle_id, tag_id) VALUES (?, ?)`)
        .bind(id, tagId).run();
    }
  }

  const row = await env.DB.prepare(`SELECT * FROM bottles WHERE id = ?`).bind(id).first();
  return json({ bottle: row }, { status: 201 });
}

async function handleUpdateBottle(request: Request, env: Env, id: string) {
  const ownerId = await getOwnerId(request);
  const body = await request.json();

  // Verify ownership
  const existing = await env.DB.prepare(`SELECT owner_id FROM bottles WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: 'not found' }, { status: 404 });
  if (existing.owner_id !== ownerId) return json({ error: 'forbidden' }, { status: 403 });

  const fields = [
    'brand','product_name','base_spirit','style','abv','volume_ml','quantity','status',
    'purchase_date','price_cents','currency','location','notes','image_url'
  ] as const;

  const updates: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (f in body) { updates.push(`${f} = ?`); params.push((body as any)[f]); }
  }
  if (updates.length) {
    const sql = `UPDATE bottles SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
    params.push(id);
    await env.DB.prepare(sql).bind(...params).run();
  }

  // Tags sync
  if (Array.isArray(body.tags)) {
    const names: string[] = body.tags;
    const current = await env.DB.prepare(`SELECT t.id, t.name FROM tags t
      JOIN bottle_tags bt ON bt.tag_id = t.id WHERE bt.bottle_id = ?`).bind(id).all();
    const currentNames = new Set((current.results || []).map((r: any) => r.name));
    const nextNames = new Set(names);

    // Add missing
    for (const name of nextNames) {
      if (!currentNames.has(name)) {
        const ex = await env.DB.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).bind(ownerId, name).first();
        const tagId = ex?.id || crypto.randomUUID();
        if (!ex) {
          await env.DB.prepare(`INSERT INTO tags (id, owner_id, name) VALUES (?, ?, ?)`)
            .bind(tagId, ownerId, name).run();
        }
        await env.DB.prepare(`INSERT OR IGNORE INTO bottle_tags (bottle_id, tag_id) VALUES (?, ?)`)
          .bind(id, tagId).run();
      }
    }
    // Remove extra
    for (const { id: tagId, name } of (current.results as any[] || [])) {
      if (!nextNames.has(name)) {
        await env.DB.prepare(`DELETE FROM bottle_tags WHERE bottle_id = ? AND tag_id = ?`).bind(id, tagId).run();
      }
    }
  }

  const row = await env.DB.prepare(`SELECT * FROM bottles WHERE id = ?`).bind(id).first();
  return json({ bottle: row });
}

async function handleDeleteBottle(request: Request, env: Env, id: string) {
  const ownerId = await getOwnerId(request);
  const existing = await env.DB.prepare(`SELECT owner_id FROM bottles WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: 'not found' }, { status: 404 });
  if (existing.owner_id !== ownerId) return json({ error: 'forbidden' }, { status: 403 });

  await env.DB.prepare(`DELETE FROM bottles WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pre = corsPreflight(request);
    if (pre) return pre;

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '');

      if (request.method === 'GET' && path.endsWith('/api/health')) {
        return withCORS(json({ ok: true }));
      }

      if (path.endsWith('/api/bottles')) {
        if (request.method === 'GET') {
          return withCORS(await handleListBottles(request, env));
        }
        if (request.method === 'POST') {
          return withCORS(await handleCreateBottle(request, env));
        }
      }

      const match = path.match(/\/api\/bottles\/(.+)$/);
      if (match) {
        const id = match[1];
        if (request.method === 'PUT') {
          return withCORS(await handleUpdateBottle(request, env, id));
        }
        if (request.method === 'DELETE') {
          return withCORS(await handleDeleteBottle(request, env, id));
        }
      }

      return withCORS(json({ error: 'not found' }, { status: 404 }));
    } catch (err: any) {
      return withCORS(json({ error: err.message || 'server error' }, { status: 500 }));
    }
  }
};
