import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { readLimitedHistory } from "@/lib/edge/analytics/limited-history";
import { runLimitedRetention } from "@/lib/edge/scheduled-tasks/limited-retention";
import type { Env } from "@/lib/edge/types";

const requireFromWrangler = createRequire(
  require.resolve("wrangler/package.json"),
);
const { Miniflare } = requireFromWrangler("miniflare");

describe("limited analytics retention on workerd", () => {
  it("aggregates a settled day once before deleting details and survives a retry", async () => {
    const mf = new Miniflare({
      workers: [
        {
          config: {
            name: "test",
            compatibilityDate: "2026-10-19",
            manifest: {
              mainModule: "index.js",
              modulesRoot: "/",
              modules: {
                "index.js": {
                  type: "esm",
                  contents:
                    "export default { fetch() { return new Response('ok') } }",
                },
              },
            },
            env: { DB: { type: "d1", id: "test-db" } },
          },
        },
      ],
    });
    try {
      const db = await mf.getD1Database("DB");
      const schema = [
        "CREATE TABLE scheduled_task_schedule_state (task_key TEXT PRIMARY KEY, next_run_at INTEGER)",
        "CREATE TABLE site_identities (site_pk INTEGER PRIMARY KEY, site_id TEXT)",
        "CREATE TABLE sites (id TEXT PRIMARY KEY)",
        "CREATE TABLE custom_event_names (id INTEGER PRIMARY KEY, site_pk INTEGER, name TEXT)",
        "CREATE TABLE visits (visit_id TEXT PRIMARY KEY, site_pk INTEGER, started_at INTEGER, pathname TEXT, referrer_host TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT)",
        "CREATE TABLE custom_events (event_pk INTEGER PRIMARY KEY, event_name_id INTEGER, site_pk INTEGER, visit_id TEXT, occurred_at INTEGER)",
        "CREATE TABLE visit_hourly_rollups (site_pk INTEGER, hour_bucket INTEGER)",
        "CREATE INDEX idx_custom_events_site_pk_time ON custom_events(site_pk, occurred_at, event_pk)",
      ];
      for (const sql of schema) await db.prepare(sql).run();
      const migration = readFileSync(
        "migrations/0045_limited_analytics_retention.sql",
        "utf8",
      );
      for (const sql of migration.split(/;\s*\n\s*\n/))
        if (sql.trim()) await db.prepare(sql).run();
      const day = Date.UTC(2026, 8, 1);
      const now = day + 32 * 86400000;
      await db
        .prepare("INSERT INTO site_identities VALUES (1, 'site-1')")
        .run();
      await db
        .prepare(
          "INSERT INTO limited_analytics_retention (site_pk, managed_from_ms, sealed_before_ms, next_day_ms) VALUES (1, ?, ?, ?)",
        )
        .bind(day, day, day)
        .run();
      await db
        .prepare(
          "INSERT INTO visits VALUES ('v1', 1, ?, '/article', 'example.com', 'newsletter', 'email', 'launch')",
        )
        .bind(day + 1000)
        .run();
      await db
        .prepare("INSERT INTO custom_events VALUES (1, 4, 1, 'v1', ?)")
        .bind(day + 2000)
        .run();
      await runLimitedRetention({ DB: db } as Env, now);
      await runLimitedRetention({ DB: db } as Env, now);
      const history = await readLimitedHistory(
        { DB: db } as Env,
        "site-1",
        "2026-09",
      );
      expect(history.enabled).toBe(true);
      expect(history.rows).toEqual([
        { dimension: "event_total", value: "", total: 1 },
        { dimension: "views", value: "", total: 1 },
      ]);
      expect(
        (await readLimitedHistory({ DB: db } as Env, "unknown", "2026-09"))
          .enabled,
      ).toBe(false);
      await expect(
        readLimitedHistory({ DB: db } as Env, "site-1", "2026-13"),
      ).rejects.toThrow("Invalid month");
      expect(
        (
          await db
            .prepare(
              "SELECT dimension, value, count FROM limited_analytics_daily_counts WHERE day_ms = ? ORDER BY dimension",
            )
            .bind(day)
            .all()
        ).results,
      ).toEqual([
        { dimension: "event_total", value: "", count: 1 },
        { dimension: "views", value: "", count: 1 },
      ]);
      expect(
        (await db.prepare("SELECT COUNT(*) AS count FROM visits").first())
          ?.count,
      ).toBe(0);
      expect(
        (
          await db
            .prepare("SELECT COUNT(*) AS count FROM custom_events")
            .first()
        )?.count,
      ).toBe(0);
      await db
        .prepare("INSERT INTO site_identities VALUES (2, 'site-2')")
        .run();
      await db
        .prepare(
          "INSERT INTO limited_analytics_retention (site_pk, managed_from_ms, sealed_before_ms, next_day_ms, phase, processing_day_ms) VALUES (2, ?, ?, ?, 'aggregated', ?)",
        )
        .bind(day, day + 86400000, day, day)
        .run();
      await db
        .prepare(
          "INSERT INTO limited_analytics_daily_counts VALUES (2, ?, 'views', '', 2)",
        )
        .bind(day)
        .run();
      // This row represents detail left after an earlier delete batch committed.
      // Temporarily insert it before restoring the persisted sealed watermark.
      await db
        .prepare(
          "UPDATE limited_analytics_retention SET sealed_before_ms = ? WHERE site_pk = 2",
        )
        .bind(day)
        .run();
      await db
        .prepare(
          "INSERT INTO visits VALUES ('v2', 2, ?, '/article', '', '', '', '')",
        )
        .bind(day + 1000)
        .run();
      await db
        .prepare(
          "UPDATE limited_analytics_retention SET sealed_before_ms = ? WHERE site_pk = 2",
        )
        .bind(day + 86400000)
        .run();
      await runLimitedRetention({ DB: db } as Env, now);
      expect(
        await db
          .prepare(
            "SELECT count FROM limited_analytics_daily_counts WHERE site_pk = 2 AND day_ms = ? AND dimension = 'views'",
          )
          .bind(day)
          .first(),
      ).toEqual({ count: 2 });
      expect(
        await db
          .prepare(
            "SELECT phase FROM limited_analytics_retention WHERE site_pk = 2",
          )
          .first(),
      ).toEqual({ phase: "idle" });
    } finally {
      await mf.dispose();
    }
  }, 30000);
});
