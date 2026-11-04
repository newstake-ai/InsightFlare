import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { limitedHistoryCutoff } from "@/lib/edge/scheduled-tasks/limited-retention";

describe("limited retention fence", () => {
  it("accepts current visits while preventing a delayed write from recreating a sealed visit", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE scheduled_task_schedule_state (task_key TEXT PRIMARY KEY, next_run_at INTEGER);
      CREATE TABLE site_identities (site_pk INTEGER PRIMARY KEY, site_id TEXT);
      CREATE TABLE sites (id TEXT PRIMARY KEY);
      CREATE TABLE visits (visit_id TEXT PRIMARY KEY, site_pk INTEGER, started_at INTEGER, status TEXT);
      CREATE TABLE custom_events (event_id TEXT PRIMARY KEY, site_pk INTEGER, visit_id TEXT, occurred_at INTEGER);
      CREATE TABLE visit_hourly_rollups (site_pk INTEGER, hour_bucket INTEGER);
      INSERT INTO site_identities VALUES (1, 'site');
    `);
    db.exec(
      readFileSync("migrations/0045_limited_analytics_retention.sql", "utf8"),
    );
    db.exec(
      "INSERT INTO limited_analytics_retention (site_pk, managed_from_ms, sealed_before_ms, next_day_ms) VALUES (1, 1000, 2000, 1000)",
    );
    db.exec("INSERT INTO visits VALUES ('sealed', 1, 1500, 'open')");
    db.exec("INSERT INTO visits VALUES ('current', 1, 2500, 'open')");
    expect(
      db.prepare("SELECT visit_id FROM visits ORDER BY visit_id").all(),
    ).toEqual([{ visit_id: "current" }]);
    db.close();
  });
});

describe("limited history expiry", () => {
  it("uses the UTC day 25 calendar months earlier, clamping short months", () => {
    expect(limitedHistoryCutoff(Date.UTC(2026, 0, 31, 23))).toBe(
      Date.UTC(2023, 11, 31),
    );
    expect(limitedHistoryCutoff(Date.UTC(2026, 2, 31))).toBe(
      Date.UTC(2024, 1, 29),
    );
    expect(limitedHistoryCutoff(Date.UTC(2025, 2, 31))).toBe(
      Date.UTC(2023, 1, 28),
    );
  });
});
