-- 004-classification-rules-match-mode.sql
--
-- Adds explicit match_mode column ('exact' | 'glob') to classification_rules,
-- defaulting to 'exact' for zero-regression backward compatibility.

ALTER TABLE classification_rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'exact' CHECK (match_mode IN ('exact', 'glob'));

DROP INDEX IF EXISTS idx_classification_rules_lookup;
CREATE INDEX IF NOT EXISTS idx_classification_rules_lookup ON classification_rules(selector_type, match_mode, selector_value);
