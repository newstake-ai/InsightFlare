import type { Env } from "@/lib/edge/types";

const DAY_MS = 86400000;
const RETENTION_MS = 30 * DAY_MS;
const DELETE_LIMIT = 200;
const MAX_BATCHES = 10;

interface RetentionState {
  sitePk: number;
  managedFrom: number;
  nextDay: number;
  phase: string;
}

function summaryStatement(
  db: D1Database,
  state: RetentionState,
  dimension: string,
  source: string,
  value: string,
): D1PreparedStatement {
  const start = Math.max(state.nextDay, state.managedFrom);
  const end = state.nextDay + DAY_MS;
  const table =
    source === "custom_events"
      ? "custom_events INDEXED BY idx_custom_events_site_pk_time"
      : source;
  return db
    .prepare(
      `INSERT OR REPLACE INTO limited_analytics_daily_counts (site_pk, day_ms, dimension, value, count)
    SELECT ?, ?, ?, ${value}, COUNT(*) FROM ${table}
    WHERE site_pk = ? AND ${source === "visits" ? "started_at" : "occurred_at"} >= ? AND ${source === "visits" ? "started_at" : "occurred_at"} < ?
      AND EXISTS (SELECT 1 FROM limited_analytics_retention WHERE site_pk = ? AND phase = 'sealed' AND processing_day_ms = ?)
    GROUP BY ${value}${["views", "event_total"].includes(dimension) ? "" : " HAVING COUNT(*) >= 3"}`,
    )
    .bind(
      state.sitePk,
      state.nextDay,
      dimension,
      state.sitePk,
      start,
      end,
      state.sitePk,
      state.nextDay,
    );
}

async function aggregateDay(
  db: D1Database,
  state: RetentionState,
): Promise<void> {
  const statements = [
    summaryStatement(db, state, "views", "visits", "''"),
    summaryStatement(db, state, "event_total", "custom_events", "''"),
    summaryStatement(db, state, "path", "visits", "pathname"),
    summaryStatement(db, state, "referrer", "visits", "referrer_host"),
    summaryStatement(
      db,
      state,
      "campaign",
      "visits",
      "json_array(utm_source, utm_medium, utm_campaign)",
    ),
    summaryStatement(
      db,
      state,
      "events",
      "custom_events",
      "CAST(event_name_id AS TEXT)",
    ),
    db
      .prepare(
        "UPDATE limited_analytics_retention SET phase = 'aggregated' WHERE site_pk = ? AND phase = 'sealed' AND processing_day_ms = ?",
      )
      .bind(state.sitePk, state.nextDay),
  ];
  await db.batch(statements);
}

async function deleteBatch(
  db: D1Database,
  state: RetentionState,
  cutoff: number,
): Promise<number> {
  const start = Math.max(state.nextDay, state.managedFrom);
  const end = Math.min(state.nextDay + DAY_MS, cutoff);
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM custom_events WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, event_pk LIMIT ?)
      AND EXISTS (SELECT 1 FROM limited_analytics_retention WHERE site_pk = ? AND phase = 'aggregated' AND processing_day_ms = ?)`,
      )
      .bind(
        state.sitePk,
        start,
        end,
        DELETE_LIMIT,
        state.sitePk,
        state.nextDay,
      ),
    db
      .prepare(
        `DELETE FROM visits WHERE visit_id IN (SELECT v.visit_id FROM visits v WHERE v.site_pk = ? AND v.started_at >= ? AND v.started_at < ? AND NOT EXISTS (SELECT 1 FROM custom_events e WHERE e.site_pk = v.site_pk AND e.visit_id = v.visit_id) ORDER BY v.started_at, v.visit_id LIMIT ?)
      AND EXISTS (SELECT 1 FROM limited_analytics_retention WHERE site_pk = ? AND phase = 'aggregated' AND processing_day_ms = ?)`,
      )
      .bind(
        state.sitePk,
        start,
        end,
        DELETE_LIMIT,
        state.sitePk,
        state.nextDay,
      ),
  ]);
  return results.reduce(
    (total, result) => total + Number(result.meta.changes || 0),
    0,
  );
}

async function processSite(
  db: D1Database,
  state: RetentionState,
  now: number,
): Promise<void> {
  const cutoff = now - RETENTION_MS;
  const end = state.nextDay + DAY_MS;
  if (state.phase === "idle") {
    if (state.nextDay >= cutoff) return;
    await db
      .prepare(
        "UPDATE limited_analytics_retention SET phase = 'sealed', processing_day_ms = next_day_ms, sealed_before_ms = ? WHERE site_pk = ? AND phase = 'idle' AND next_day_ms = ?",
      )
      .bind(end, state.sitePk, state.nextDay)
      .run();
    state.phase = "sealed";
  }
  if (state.phase === "sealed") await aggregateDay(db, state);
  for (let i = 0; i < MAX_BATCHES; i++) {
    if ((await deleteBatch(db, state, cutoff)) === 0) break;
  }
  await db
    .prepare(
      "DELETE FROM visit_hourly_rollups WHERE site_pk = ? AND hour_bucket >= ? AND hour_bucket < ? AND EXISTS (SELECT 1 FROM limited_analytics_retention WHERE site_pk = ? AND phase = 'aggregated' AND processing_day_ms = ?)",
    )
    .bind(
      state.sitePk,
      Math.floor(state.nextDay / 3600000),
      Math.floor(Math.min(end, cutoff) / 3600000),
      state.sitePk,
      state.nextDay,
    )
    .run();
  if (cutoff < end) return;
  const finish = await db.batch([
    db
      .prepare(
        `UPDATE limited_analytics_retention SET next_day_ms = ?, phase = 'idle', processing_day_ms = NULL, last_error = NULL
      WHERE site_pk = ? AND phase = 'aggregated' AND processing_day_ms = ?
      AND NOT EXISTS (SELECT 1 FROM visits WHERE site_pk = ? AND started_at >= ? AND started_at < ?)
      AND NOT EXISTS (SELECT 1 FROM custom_events WHERE site_pk = ? AND occurred_at >= ? AND occurred_at < ?)`,
      )
      .bind(
        end,
        state.sitePk,
        state.nextDay,
        state.sitePk,
        Math.max(state.nextDay, state.managedFrom),
        end,
        state.sitePk,
        Math.max(state.nextDay, state.managedFrom),
        end,
      ),
  ]);
  if (Number(finish[0]?.meta.changes || 0) === 0) {
    await db
      .prepare(
        "UPDATE limited_analytics_retention SET last_error = 'Deletion pending: backlog or newer child events' WHERE site_pk = ? AND phase = 'aggregated' AND processing_day_ms = ?",
      )
      .bind(state.sitePk, state.nextDay)
      .run();
  }
}

export function limitedHistoryCutoff(now: number): number {
  const month = new Date(now);
  const target = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 25, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(month.getUTCDate(), lastDay),
  );
}

export async function runLimitedRetention(
  env: Env,
  now: number,
): Promise<{ status: "success" | "partial"; summary: Record<string, number> }> {
  const rows = await env.DB.prepare(
    "SELECT site_pk AS sitePk, managed_from_ms AS managedFrom, next_day_ms AS nextDay, phase FROM limited_analytics_retention WHERE phase IN ('idle', 'sealed', 'aggregated') ORDER BY next_day_ms LIMIT 10",
  ).all<RetentionState>();
  let failed = 0;
  const expiry = limitedHistoryCutoff(now);
  for (const state of rows.results) {
    try {
      await processSite(env.DB, state, now);
      await env.DB.prepare(
        "DELETE FROM limited_analytics_daily_counts WHERE rowid IN (SELECT rowid FROM limited_analytics_daily_counts WHERE site_pk = ? AND day_ms < ? LIMIT ?)",
      )
        .bind(state.sitePk, expiry, DELETE_LIMIT)
        .run();
    } catch (error) {
      failed++;
      await env.DB.prepare(
        "UPDATE limited_analytics_retention SET last_error = ? WHERE site_pk = ?",
      )
        .bind(String(error).slice(0, 400), state.sitePk)
        .run();
    }
  }
  return {
    status: failed ? "partial" : "success",
    summary: { sites: rows.results.length, failed },
  };
}
