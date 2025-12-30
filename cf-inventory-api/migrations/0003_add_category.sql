-- Add category column to support spirit subcategories (e.g., tequila → blanco/reposado/anejo)
ALTER TABLE bottles ADD COLUMN category TEXT;

-- Add index for efficient category-based queries and filtering
CREATE INDEX idx_bottles_category ON bottles(category);
