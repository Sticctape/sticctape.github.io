-- D1 schema for bottle inventory
PRAGMA foreign_keys = ON;

-- Users table (owner of inventories)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_users_updated
AFTER UPDATE ON users FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- Bottles table
CREATE TABLE IF NOT EXISTS bottles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  product_name TEXT NOT NULL,
  base_spirit TEXT,          -- rum, gin, tequila, bourbon, liqueur, etc.
  style TEXT,                -- london dry, reposado, amaro nonino, etc.
  abv REAL,                  -- percent (e.g., 40.0)
  volume_ml INTEGER,         -- nominal bottle size
  quantity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'sealed' CHECK (status IN ('sealed','open','empty')),
  purchase_date TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  location TEXT,             -- bar shelf or cabinet
  notes TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_bottles_updated
AFTER UPDATE ON bottles FOR EACH ROW
BEGIN
  UPDATE bottles SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- Tags and many-to-many mapping
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, name),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_tags_updated
AFTER UPDATE ON tags FOR EACH ROW
BEGIN
  UPDATE tags SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS bottle_tags (
  bottle_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (bottle_id, tag_id),
  FOREIGN KEY (bottle_id) REFERENCES bottles(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Share tokens for read-only or collaborative sharing
CREATE TABLE IF NOT EXISTS share_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('view','edit')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Canonical ingredients and aliases (for makeable logic)
CREATE TABLE IF NOT EXISTS canonical_ingredients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_spirit TEXT
);

CREATE TABLE IF NOT EXISTS ingredient_aliases (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  FOREIGN KEY (canonical_id) REFERENCES canonical_ingredients(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bottles_owner ON bottles(owner_id);
CREATE INDEX IF NOT EXISTS idx_bottles_search ON bottles(brand, product_name);
CREATE INDEX IF NOT EXISTS idx_bottles_filters ON bottles(base_spirit, style, status);
CREATE INDEX IF NOT EXISTS idx_tags_owner ON tags(owner_id);
CREATE INDEX IF NOT EXISTS idx_bt_bottle ON bottle_tags(bottle_id);
CREATE INDEX IF NOT EXISTS idx_bt_tag ON bottle_tags(tag_id);
