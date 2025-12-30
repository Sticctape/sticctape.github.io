export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  JWT_SECRET?: string;        // set via `wrangler secret put JWT_SECRET`
  JWT_AUD?: string;           // optional audience check
  JWT_ISS?: string;           // optional issuer check
  STAFF_API_TOKEN?: string;   // legacy staff token secret (used by staff-auth)
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
  'http://127.0.0.1:5500',
  'http://192.168.125.247:5500',
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
async function isValidStaffToken(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;

  const token = auth.slice(7).trim();
  if (!token) return false;

  // Format 1: legacy prefix
  if (token.startsWith('staff_')) return true;

  // Format 2: HS256 JWT (sub = staff)
  if (token.includes('.')) {
    // First try JWT verification if JWT_SECRET is configured
    if (env.JWT_SECRET) {
      try {
        const sub = await verifyJWT(token, env);
        if (sub === 'staff') return true;
      } catch (_) {
        // fall through to legacy staff-auth token check
      }
    }

    // Format 3: Legacy staff-auth token from staff-auth worker
    // Structure: base64(payload) + '.' + STAFF_API_TOKEN prefix (20 chars)
    if (env.STAFF_API_TOKEN) {
      const parts = token.split('.');
      if (parts.length === 2) {
        const [payloadB64, sigPrefix] = parts;
        const expectedPrefix = env.STAFF_API_TOKEN.substring(0, 20);
        if (sigPrefix === expectedPrefix) {
          try {
            const payload = JSON.parse(atob(payloadB64));
            const now = Math.floor(Date.now() / 1000);
            if (payload.sub === 'staff' && (!payload.exp || now <= payload.exp)) {
              return true;
            }
          } catch (_) {
            // malformed payload
          }
        }
      }
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
  
  // If ownerId is provided, filter by owner. Normalize unstable owner tokens.
  if (ownerId) {
    // When ownerId uses ephemeral tokens (e.g., "owner:owner_abc"), match any owner-prefixed records.
    if (ownerId.startsWith('owner:')) {
      where.push(`b.owner_id LIKE ?`);
      params.push('owner:%');
    } else {
      where.push(`b.owner_id = ?`);
      params.push(ownerId);
    }
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
    brand, product_name, base_spirit, style, category, abv, volume_ml, quantity = 1,
    status = 'sealed', purchase_date, price_cents, currency = 'USD', location, notes, image_url, upc, tags
  } = body || {};

  // Normalize undefined -> null for optional fields (D1 rejects undefined)
  const base = base_spirit ?? null;
  const styleVal = style ?? null;
  const categoryVal = category ?? null;
  const abvVal = abv ?? null;
  const volVal = volume_ml ?? null;
  const statusVal = status ?? null;
  const purchaseVal = purchase_date ?? null;
  const priceVal = price_cents ?? null;
  const currencyVal = currency ?? null;
  const locationVal = location ?? null;
  const notesVal = notes ?? null;
  const imageVal = image_url ?? null;
  const upcVal = upc ?? null;

  if (!brand || !product_name) {
    return json({ error: 'brand and product_name are required' }, { status: 400 });
  }

  try {
    // Normalize owner_id to a stable value for future reads
    const normalizedOwnerId = ownerId.startsWith('owner:') ? 'owner:primary' : ownerId;
    const stmt = env.DB.prepare(`INSERT INTO bottles (
      id, owner_id, brand, product_name, base_spirit, style, category, abv, volume_ml, quantity, status,
      purchase_date, price_cents, currency, location, notes, image_url, upc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, normalizedOwnerId, brand, product_name, base, styleVal, categoryVal, abvVal, volVal, quantity, statusVal,
          purchaseVal, priceVal, currencyVal, locationVal, notesVal, imageVal, upcVal);

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
  // Allow if both are owner-prefixed (normalized) or exact match otherwise
  if (!(ownerId && existing.owner_id && (
        (ownerId.startsWith('owner:') && String(existing.owner_id).startsWith('owner:')) ||
        (existing.owner_id === ownerId)
      ))) {
    return json({ error: 'forbidden' }, { status: 403 });
  }

  const fields = [
    'brand','product_name','base_spirit','style','category','abv','volume_ml','quantity','status',
    'purchase_date','price_cents','currency','location','notes','image_url','upc'
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
  // Allow if both are owner-prefixed (normalized) or exact match otherwise
  if (!(ownerId && existing.owner_id && (
        (ownerId.startsWith('owner:') && String(existing.owner_id).startsWith('owner:')) ||
        (existing.owner_id === ownerId)
      ))) {
    return json({ error: 'forbidden' }, { status: 403 });
  }

  await env.DB.prepare(`DELETE FROM bottles WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function handleImageUpload(request: Request, env: Env, bottleId: string, ownerId: string) {
  // Verify bottle ownership first
  const bottle = await env.DB.prepare(`SELECT owner_id FROM bottles WHERE id = ?`).bind(bottleId).first();
  if (!bottle) {
    console.error(`[IMG] Bottle not found: ${bottleId}`);
    return json({ error: 'not found' }, { status: 404 });
  }
  
  if (!(ownerId && bottle.owner_id && (
        (ownerId.startsWith('owner:') && String(bottle.owner_id).startsWith('owner:')) ||
        (bottle.owner_id === ownerId)
      ))) {
    console.error(`[IMG] Access denied for bottle ${bottleId}. ownerId: ${ownerId}, bottleOwner: ${bottle.owner_id}`);
    return json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const contentType = request.headers.get('content-type') || 'image/jpeg';
    console.log(`[IMG] Received upload: ${bottleId}, contentType: ${contentType}`);
    
    // Validate content type is an image
    if (!contentType.startsWith('image/')) {
      return json({ error: 'Invalid file type. Only images are allowed.' }, { status: 400 });
    }

    const buffer = await request.arrayBuffer();
    console.log(`[IMG] Buffer size: ${buffer.byteLength} bytes`);
    
    // Check file size (max 5MB)
    if (buffer.byteLength > 5 * 1024 * 1024) {
      return json({ error: 'File too large. Maximum 5MB.' }, { status: 400 });
    }

    // Generate unique filename with timestamp
    const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
    const filename = `bottles/${bottleId}-${Date.now()}.${ext}`;
    console.log(`[IMG] Uploading to R2: ${filename}`);
    
    // Upload to R2
    await env.IMAGES.put(filename, buffer, {
      httpMetadata: {
        contentType: contentType,
        cacheControl: 'public, max-age=31536000' // Cache for 1 year
      }
    });
    console.log(`[IMG] R2 upload successful: ${filename}`);

    // Generate public URL for the image
    const imageUrl = `https://images.streeter.cc/${filename}`;
    
    // Update bottle record with image URL
    console.log(`[IMG] Updating database - bottleId: ${bottleId}, imageUrl: ${imageUrl}`);
    await env.DB.prepare(`UPDATE bottles SET image_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(imageUrl, bottleId).run();
    console.log(`[IMG] Database updated successfully`);

    return json({ 
      success: true, 
      imageUrl: imageUrl,
      filename: filename
    });
  } catch (err: any) {
    console.error(`[IMG] Error uploading image: ${err.message}`, err);
    return json({ error: `Image upload failed: ${err.message}` }, { status: 500 });
  }
}

async function handleImageDelete(request: Request, env: Env, bottleId: string, ownerId: string) {
  // Verify bottle ownership first
  const bottle = await env.DB.prepare(`SELECT owner_id, image_url FROM bottles WHERE id = ?`).bind(bottleId).first();
  if (!bottle) return json({ error: 'not found' }, { status: 404 });
  
  if (!(ownerId && bottle.owner_id && (
        (ownerId.startsWith('owner:') && String(bottle.owner_id).startsWith('owner:')) ||
        (bottle.owner_id === ownerId)
      ))) {
    return json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    // Extract filename from URL if it exists
    if (bottle.image_url) {
      const match = bottle.image_url.match(/\/([^/]+\/[^/]+)$/);
      if (match) {
        const filename = match[1];
        // Delete from R2
        await env.IMAGES.delete(filename);
      }
    }

    // Clear image URL from database
    await env.DB.prepare(`UPDATE bottles SET image_url = NULL, updated_at = datetime('now') WHERE id = ?`)
      .bind(bottleId).run();

    return json({ success: true });
  } catch (err: any) {
    return json({ error: `Image delete failed: ${err.message}` }, { status: 500 });
  }
}

async function handleUPCLookup(request: Request, env: Env, upc: string) {
  // This endpoint acts as a CORS proxy for the UPCItemDB API
  // Benefits: 
  // 1. Handles CORS (browser can't call UPCItemDB directly)
  // 2. Hides API endpoint from client
  // 3. Enables rate limiting and caching
  // 4. Could cache results in D1/KV for frequently looked up items
  
  // Validate UPC format (should be numeric and reasonable length)
  if (!upc || !/^\d{6,14}$/.test(upc)) {
    return json({ error: 'Invalid UPC format' }, { status: 400 });
  }

  try {
    const apiUrl = `https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`;
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'BarInventory/1.0'
      }
    });

    if (!response.ok) {
      return json({ error: `UPC API returned status ${response.status}` }, { status: response.status });
    }

    const data = await response.json();
    
    // Check if we got results
    if (data.code !== 'OK' || !data.items || data.items.length === 0) {
      return json({ error: 'No product found for this UPC', data }, { status: 404 });
    }

    // Return the first item with all its data
    return json({ 
      success: true, 
      product: data.items[0],
      rateLimit: {
        limit: response.headers.get('x-ratelimit-limit'),
        remaining: response.headers.get('x-ratelimit-remaining'),
        reset: response.headers.get('x-ratelimit-reset')
      }
    });
  } catch (err: any) {
    return json({ error: `UPC lookup failed: ${err.message}` }, { status: 500 });
  }
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
      
      console.log(`[ROUTE] ${request.method} ${rawPath} -> path: ${path}, isAdmin: ${isAdmin}`);

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
      const isStaff = await isValidStaffToken(request, env);
      
      // Auth check endpoint - returns whether user is authenticated and their role
      if (request.method === 'GET' && path.endsWith('/api/auth/check')) {
        return withCORS(json({ 
          authenticated: !!ownerId || isStaff, 
          ownerId: ownerId || null,
          isStaff: isStaff,
          isOwner: !!ownerId
        }), request);
      }

      // UPC lookup endpoint (admin only, owner required)
      const upcMatch = path.match(/\/api\/upc\/(.+)$/);
      if (upcMatch && request.method === 'GET') {
        if (!isAdmin) return withCORS(json({ error: 'not found' }, { status: 404 }), request);
        if (!ownerId) return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
        return withCORS(await handleUPCLookup(request, env, upcMatch[1]), request);
      }

      // Image upload endpoint: POST /api/admin/bottles/{id}/image
      // Image delete endpoint: DELETE /api/admin/bottles/{id}/image
      const imageMatch = path.match(/\/api\/bottles\/(.+?)\/image$/);
      if (imageMatch) {
        const bottleId = imageMatch[1];
        console.log(`[IMG] Route match! bottleId: ${bottleId}, method: ${request.method}, path: ${path}`);
        
        if (request.method === 'POST') {
          if (!isAdmin) {
            console.log(`[IMG] Not admin path`);
            return withCORS(json({ error: 'not found' }, { status: 404 }), request);
          }
          if (!ownerId) {
            console.log(`[IMG] No owner ID`);
            return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          }
          console.log(`[IMG] Uploading image for bottle ${bottleId}, ownerId: ${ownerId}`);
          return withCORS(await handleImageUpload(request, env, bottleId, ownerId), request);
        }
        
        if (request.method === 'DELETE') {
          if (!isAdmin) return withCORS(json({ error: 'not found' }, { status: 404 }), request);
          if (!ownerId) return withCORS(json({ error: 'Unauthorized' }, { status: 401 }), request);
          console.log(`[IMG] Deleting image for bottle ${bottleId}`);
          return withCORS(await handleImageDelete(request, env, bottleId, ownerId), request);
        }
      } else {
        // Log why route didn't match
        if (path.includes('/image')) {
          console.log(`[IMG] Route NOT matched! path: ${path}, isAdmin: ${isAdmin}`);
        }
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
