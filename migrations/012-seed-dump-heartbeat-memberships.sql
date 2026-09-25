-- Migration 006 seeded historical heartbeats that existed at migration time.
-- Later dump imports also need active day memberships so their machine and
-- editor identities can be verified by classification. Never seed a day that
-- already has membership history or an accepted live heartbeat snapshot.

CREATE TABLE _dump_membership_seed_dates (date TEXT PRIMARY KEY);

INSERT INTO _dump_membership_seed_dates (date)
SELECT DISTINCT h.local_date
FROM heartbeats h
JOIN source_imports si ON si.id = h.source_import_id
WHERE si.source_type = 'heartbeat_dump'
  AND NOT EXISTS (
    SELECT 1 FROM heartbeat_memberships hm WHERE hm.date = h.local_date
  )
  AND NOT EXISTS (
    SELECT 1 FROM sync_layer_state sls
    WHERE sls.date = h.local_date
      AND sls.layer = 'heartbeats'
      AND (sls.accepted_snapshot_version > 0 OR sls.accepted_content_hash IS NOT NULL)
  );

INSERT INTO heartbeat_memberships (date, heartbeat_id, active)
SELECT h.local_date, h.id, 1
FROM heartbeats h
JOIN source_imports si ON si.id = h.source_import_id
JOIN _dump_membership_seed_dates d ON d.date = h.local_date
WHERE si.source_type = 'heartbeat_dump';

DROP TABLE _dump_membership_seed_dates;
