-- Support SQLite foreign-key cascade checks when visits are deleted.
CREATE INDEX idx_custom_events_visit_retention ON custom_events(visit_id);

-- This state is installed only when a site explicitly enters limited mode.
CREATE TABLE limited_analytics_retention (
  site_pk INTEGER PRIMARY KEY REFERENCES site_identities(site_pk),
  managed_from_ms INTEGER NOT NULL,
  sealed_before_ms INTEGER NOT NULL,
  next_day_ms INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idle',
  processing_day_ms INTEGER,
  last_error TEXT
);

CREATE TABLE limited_analytics_daily_counts (
  site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
  day_ms INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (site_pk, day_ms, dimension, value)
);

CREATE TRIGGER limited_visits_insert_fence BEFORE INSERT ON visits
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND NEW.started_at >= r.managed_from_ms AND NEW.started_at < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER limited_visits_update_fence BEFORE UPDATE ON visits
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = OLD.site_pk AND OLD.started_at >= r.managed_from_ms AND OLD.started_at < r.sealed_before_ms)
  OR EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND NEW.started_at >= r.managed_from_ms AND NEW.started_at < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER limited_events_insert_fence BEFORE INSERT ON custom_events
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND NEW.occurred_at >= r.managed_from_ms AND NEW.occurred_at < r.sealed_before_ms)
  OR EXISTS (SELECT 1 FROM visits v JOIN limited_analytics_retention r ON r.site_pk = v.site_pk WHERE v.visit_id = NEW.visit_id AND v.started_at >= r.managed_from_ms AND v.started_at < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER limited_events_update_fence BEFORE UPDATE ON custom_events
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = OLD.site_pk AND OLD.occurred_at >= r.managed_from_ms AND OLD.occurred_at < r.sealed_before_ms)
  OR EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND NEW.occurred_at >= r.managed_from_ms AND NEW.occurred_at < r.sealed_before_ms)
  OR EXISTS (SELECT 1 FROM visits v JOIN limited_analytics_retention r ON r.site_pk = v.site_pk WHERE v.visit_id IN (OLD.visit_id, NEW.visit_id) AND v.started_at >= r.managed_from_ms AND v.started_at < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER limited_rollup_insert_fence BEFORE INSERT ON visit_hourly_rollups
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND (NEW.hour_bucket + 1) * 3600000 > r.managed_from_ms AND NEW.hour_bucket * 3600000 < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER limited_rollup_update_fence BEFORE UPDATE ON visit_hourly_rollups
WHEN EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = OLD.site_pk AND (OLD.hour_bucket + 1) * 3600000 > r.managed_from_ms AND OLD.hour_bucket * 3600000 < r.sealed_before_ms)
  OR EXISTS (SELECT 1 FROM limited_analytics_retention r WHERE r.site_pk = NEW.site_pk AND (NEW.hour_bucket + 1) * 3600000 > r.managed_from_ms AND NEW.hour_bucket * 3600000 < r.sealed_before_ms)
BEGIN SELECT RAISE(IGNORE); END;

INSERT INTO scheduled_task_schedule_state (task_key, next_run_at)
VALUES ('limited_analytics_retention', 0);

-- Keep the tombstone so delayed DO retries cannot recreate deleted site data.
CREATE TRIGGER limited_site_delete AFTER DELETE ON sites
BEGIN
  DELETE FROM limited_analytics_daily_counts WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = OLD.id);
  UPDATE limited_analytics_retention SET phase = 'deleted', sealed_before_ms = 9007199254740991, processing_day_ms = NULL WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = OLD.id);
END;
