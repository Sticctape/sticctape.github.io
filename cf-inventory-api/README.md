# Streeters Distillery Inventory API (Cloudflare Worker + D1)

This Worker exposes CRUD endpoints for managing your bottle inventory backed by a Cloudflare D1 database. Deployed at **`bar.streeter.cc/api/*`**.

## Architecture

- **Frontend**: GitHub Pages at `sticctape.github.io` (or `bar.streeter.cc`)
- **API**: Cloudflare Worker at `bar.streeter.cc/api/*`
- **Database**: Cloudflare D1 (global, serverless SQL)

## Setup & Deploy

### 1. Create the D1 database

```bash
# Install wrangler if needed
npm install -g wrangler

# Authenticate with Cloudflare
wrangler login

# Create the production database
wrangler d1 create streetersdistillery_inventory
```

Copy the `database_id` from the output and update `wrangler.toml` (replace `${D1_DATABASE_ID}` with the actual ID).

### 2. Apply migrations to production

```bash
wrangler d1 migrations apply streetersdistillery_inventory
```

### 3. Deploy the Worker

```bash
wrangler deploy
```

This publishes your Worker to Cloudflare's edge network and makes it live at:
- `https://bar.streeter.cc/api/health`
- `https://bar.streeter.cc/api/bottles`

### 4. DNS Configuration

Ensure `bar.streeter.cc` is:
- An A/AAAA record pointing to Cloudflare's proxied IPs, OR
- A CNAME to your zone apex with Cloudflare proxy enabled (orange cloud)

The Worker route will intercept `/api/*` requests automatically.

## Local Development (Optional)

```bash
# Run locally for testing
wrangler dev

# Test locally
curl -i http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/bottles -H "X-Owner-Id: you@example.com"
```

## Example API Calls (Production)

```bash
# Health check
curl -i https://bar.streeter.cc/api/health

# List bottles
curl -s https://bar.streeter.cc/api/bottles -H "X-Owner-Id: you@example.com"

# Create a bottle
curl -s -X POST https://bar.streeter.cc/api/bottles \
  -H "Content-Type: application/json" -H "X-Owner-Id: you@example.com" \
  -d '{
    "brand":"Green Chartreuse",
    "product_name":"Green Chartreuse",
    "base_spirit":"liqueur",
    "style":"herbal",
    "abv":55,
    "volume_ml":750,
    "quantity":1,
    "status":"sealed",
    "tags":["herbal","green"],
    "notes":"Keep in fridge after opening"
  }'

# Update a bottle
curl -s -X PUT https://bar.streeter.cc/api/bottles/{bottle-id} \
  -H "Content-Type: application/json" -H "X-Owner-Id: you@example.com" \
  -d '{"status":"open","quantity":1}'

# Delete a bottle
curl -s -X DELETE https://bar.streeter.cc/api/bottles/{bottle-id} \
  -H "X-Owner-Id: you@example.com"
```

## Security & Next Steps

- **Auth**: Currently uses `X-Owner-Id` header for MVP. Replace with Cloudflare Access or JWT tokens.
- **CORS**: Set to `*` for testing; will tighten to `bar.streeter.cc` or `sticctape.github.io` in production.
- **Images**: Add R2 bucket + signed upload endpoint for bottle label photos.
- **Makeable Endpoint**: Add `/api/makeable` to return recipes you can make with current inventory.
