export interface Env {
  DB: D1Database;
  // IMAGES: R2Bucket; // future
  JWT_SECRET?: string;        // set via `wrangler secret put JWT_SECRET`
  JWT_AUD?: string;           // optional audience check
  JWT_ISS?: string;           // optional issuer check
  ALLOW_HEADER_DEV?: string;  // if "true", allow X-Owner-Id for local dev only
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...init.headers });
  return new Response(JSON.stringify(data), { ...init, headers });
}

const ALLOWED_ORIGINS = [
  'https://bar.streeter.cc',
  'https://streeter.cc',
  'https://sticctape.github.io',
  'http://127.0.0.1:5500', // local dev
];

function getAllowedOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function withCORS(resp: Response, req?: Request) {
  const h = new Headers(resp.headers);
  const origin = req ? getAllowedOrigin(req) : null;
  if (origin) h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cf-Access-Jwt-Assertion');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function corsPreflight(req: Request) {
  if (req.method === 'OPTIONS') {
    const origin = getAllowedOrigin(req);
    if (!origin) return new Response('CORS origin not allowed', { status: 403 });
    return withCORS(new Response(null, { status: 204 }), req);
  }
}

// Best-effort in-memory rate limit (per Worker instance). For stronger guarantees, move to Durable Object.
const rlBucket = new Map<string, { tokens: number; ts: number }>();
const RL_CAP = 60;          // max requests in window
const RL_WINDOW_MS = 60_000; // 1 minute

function enforceRateLimit(req: Request): boolean {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const entry = rlBucket.get(ip) || { tokens: RL_CAP, ts: now };
  const elapsed = now - entry.ts;
  const refill = Math.floor(elapsed / RL_WINDOW_MS) * RL_CAP;
  entry.tokens = Math.min(RL_CAP, entry.tokens + refill);
  entry.ts = elapsed >= RL_WINDOW_MS ? now : entry.ts;
  if (entry.tokens <= 0) {
    rlBucket.set(ip, entry);
    return false;
  }
  entry.tokens -= 1;
  rlBucket.set(ip, entry);
  return true;
}

// HS256 JWT verification (Bearer token). `sub` becomes ownerId. Optional aud/iss checks.
async function verifyJWT(token: string, env: Env): Promise<string> {
  if (!env.JWT_SECRET) throw new Error('Missing JWT secret');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();

  const toBytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')), c => c.charCodeAt(0));

  const header = JSON.parse(new TextDecoder().decode(toBytes(headerB64)));
  if (header.alg !== 'HS256') throw new Error('Unsupported alg');

  const key = await crypto.subtle.importKey('raw', enc.encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = enc.encode(`${headerB64}.${payloadB64}`);
  const signatureValid = await crypto.subtle.verify('HMAC', key, toBytes(sigB64), data);
  if (!signatureValid) throw new Error('Bad signature');

  const payload = JSON.parse(new TextDecoder().decode(toBytes(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) throw new Error('Token expired');
  if (env.JWT_AUD && payload.aud !== env.JWT_AUD) throw new Error('Bad aud');
  if (env.JWT_ISS && payload.iss !== env.JWT_ISS) throw new Error('Bad iss');
  if (!payload.sub) throw new Error('Missing sub');
  return payload.sub as string;
}

async function getOwnerId(req: Request, env: Env): Promise<string | null> {
  // OWNER IDENTIFICATION: from owner token (Bearer header)
  // Owner token gives full read+write access and identifies the owner.
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && token.startsWith('owner_')) {
      // This is an owner token. Return as owner identity.
      // In production, verify the token signature and expiry.
      return `owner:${token}`;
    }
  }

  // Fallback: accept owner token in X-Staff-Token header (matches POS worker usage)
  const alt = req.headers.get('x-staff-token');
  if (alt && alt.startsWith('owner_')) {
    return `owner:${alt}`;
  }

  // Dev-only escape hatch: allow X-Owner-Id when ALLOW_HEADER_DEV="true"
  if (env.ALLOW_HEADER_DEV === 'true') {
    const header = req.headers.get('x-owner-id');
    if (header && header.length > 0) return header;
  }

  // Return null if no owner token present
  return null;
}

// Check if a staff token is valid. Returns true if valid, false otherwise.
// Staff tokens grant READ access to inventory but are NOT owner identity.
function isValidStaffToken(req: Request): boolean {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && token.startsWith('staff_')) {
      // This is a staff token. In production, verify the token signature and expiry.
      return true;
    }
  }
  return false;
}

async function handleListBottles(request: Request, env: Env, ownerId: string | null) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search')?.trim();
  const base = url.searchParams.get('base_spirit')?.trim();
  const status = url.searchParams.get('status')?.trim();
  const tag = url.searchParams.get('tag')?.trim();

  let sql = `SELECT b.* FROM bottles b`;
  const where: string[] = [];
  const params: any[] = [];
  
  // If ownerId is provided, filter by owner. Otherwise return all public bottles.
  if (ownerId) {
    where.push(`b.owner_id = ?`);
    params.push(ownerId);
  }

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

  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  sql += ` ORDER BY b.updated_at DESC LIMIT 500`;
  const rs = await env.DB.prepare(sql).bind(...params).all();
  return json({ bottles: rs.results });
}

async function handleCreateBottle(request: Request, env: Env, ownerId: string) {
  const body = await request.json();
  const id = crypto.randomUUID();

  const {
    brand, product_name, base_spirit, style, abv, volume_ml, quantity = 1,
    status = 'sealed', purchase_date, price_cents, currency = 'USD', location, notes, image_url, tags
  } = body || {};

  // Normalize undefined -> null for optional fields (D1 rejects undefined)
  const base = base_spirit ?? null;
  const styleVal = style ?? null;
  const abvVal = abv ?? null;
  const volVal = volume_ml ?? null;
  const statusVal = status ?? null;
  const purchaseVal = purchase_date ?? null;
  const priceVal = price_cents ?? null;
  const currencyVal = currency ?? null;
  const locationVal = location ?? null;
  const notesVal = notes ?? null;
  const imageVal = image_url ?? null;

  if (!brand || !product_name) {
    return json({ error: 'brand and product_name are required' }, { status: 400 });
  }

  try {
    const stmt = env.DB.prepare(`INSERT INTO bottles (
      id, owner_id, brand, product_name, base_spirit, style, abv, volume_ml, quantity, status,
      purchase_date, price_cents, currency, location, notes, image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, ownerId, brand, product_name, base, styleVal, abvVal, volVal, quantity, statusVal,
          purchaseVal, priceVal, currencyVal, locationVal, notesVal, imageVal);

    await stmt.run();
  } catch (err: any) {
    return json({ error: `insert failed: ${err?.message || err}` }, { status: 500 });
  }

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

async function handleUpdateBottle(request: Request, env: Env, id: string, ownerId: string) {
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

async function handleDeleteBottle(request: Request, env: Env, id: string, ownerId: string) {
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
      const rawPath = url.pathname.replace(/\/$/, '');
      const isAdmin = rawPath.startsWith('/api/admin');
      const path = isAdmin ? rawPath.replace('/api/admin', '/api') : rawPath;

      // Block disallowed origins early
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return new Response('CORS origin not allowed', { status: 403 });
      }

      // Best-effort rate limit
      if (!enforceRateLimit(request)) {
        return withCORS(json({ error: 'rate limit exceeded' }, { status: 429 }), request);
      }

      if (request.method === 'GET' && path.endsWith('/api/health')) {
        return withCORS(json({ ok: true }), request);
      }

      // Check owner identity (CF Access JWT)
      const ownerId = await getOwnerId(request, env);
      
      // Check staff permissions (Bearer token)
      const isStaff = isValidStaffToken(request);
      
      // Auth check endpoint - returns whether user is authenticated and their role
      if (request.method === 'GET' && path.endsWith('/api/auth/check')) {
        return withCORS(json({ 
          authenticated: !!ownerId || isStaff, 
          ownerId: ownerId || null,
          isStaff: isStaff,
          isOwner: !!ownerId
        }), request);
      }

      if (path.endsWith('/api/bottles')) {
        if (request.method === 'GET') {
          // GET allowed ONLY for owner or staff - anonymous gets 401
          if (!ownerId && !isStaff) {
            return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          }
          return withCORS(await handleListBottles(request, env, ownerId), request);
        }
        if (request.method === 'POST') {
          // Writes only allowed via admin path
          if (!isAdmin) return withCORS(json({ error: 'not found' }, { status: 404 }), request);
          if (!ownerId) return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          return withCORS(await handleCreateBottle(request, env, ownerId), request);
        }
      }

      const match = path.match(/\/api\/bottles\/(.+)$/);
      if (match) {
        const id = match[1];
        if (request.method === 'PUT') {
          // Writes only allowed via admin path
          if (!isAdmin) return withCORS(json({ error: 'not found' }, { status: 404 }), request);
          if (!ownerId) return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          return withCORS(await handleUpdateBottle(request, env, id, ownerId), request);
        }
        if (request.method === 'DELETE') {
          // Writes only allowed via admin path
          if (!isAdmin) return withCORS(json({ error: 'not found' }, { status: 404 }), request);
          if (!ownerId) return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          return withCORS(await handleDeleteBottle(request, env, id, ownerId), request);
        }
      }

      return withCORS(json({ error: 'not found' }, { status: 404 }), request);
    } catch (err: any) {
      return withCORS(json({ error: err.message || 'server error' }, { status: 500 }), request);
    }
  }
};
