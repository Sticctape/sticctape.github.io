CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bottles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  product_name TEXT NOT NULL,
  base_spirit TEXT,
  style TEXT,
  abv REAL,
  volume_ml INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'sealed',
  purchase_date TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  location TEXT,
  notes TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bottle_tags (
  bottle_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (bottle_id, tag_id)
);

CREATE TABLE share_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE canonical_ingredients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_spirit TEXT
);

CREATE TABLE ingredient_aliases (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_bottles_owner ON bottles(owner_id);
CREATE INDEX idx_bottles_search ON bottles(brand, product_name);
CREATE INDEX idx_bottles_filters ON bottles(base_spirit, style, status);
CREATE INDEX idx_tags_owner ON tags(owner_id);
CREATE INDEX idx_bt_bottle ON bottle_tags(bottle_id);
CREATE INDEX idx_bt_tag ON bottle_tags(tag_id);
