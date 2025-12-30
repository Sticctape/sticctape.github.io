-- Add UPC field to bottles table
ALTER TABLE bottles ADD COLUMN upc TEXT;

-- Add index for UPC lookups
CREATE INDEX idx_bottles_upc ON bottles(upc);
