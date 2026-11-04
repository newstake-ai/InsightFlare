import type { Env } from "@/lib/edge/types";

export async function readLimitedHistory(
  env: Env,
  siteId: string,
  month: string,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid month");
  const [year, monthNumber] = month.split("-").map(Number);
  const start = Date.UTC(year, monthNumber - 1, 1);
  const end = Date.UTC(year, monthNumber, 1);
  const [state, rows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.next_day_ms AS nextDay, r.last_error AS lastError
      FROM limited_analytics_retention r JOIN site_identities si ON si.site_pk = r.site_pk
      WHERE si.site_id = ?`,
    ).bind(siteId),
    env.DB.prepare(
      `WITH counts AS (
      SELECT d.dimension, CASE WHEN d.dimension = 'events' THEN COALESCE(n.name, 'unknown') ELSE d.value END AS value, SUM(d.count) AS total
      FROM limited_analytics_daily_counts d
      JOIN site_identities si ON si.site_pk = d.site_pk
      JOIN limited_analytics_retention r ON r.site_pk = d.site_pk
      LEFT JOIN custom_event_names n ON d.dimension = 'events' AND n.site_pk = d.site_pk AND n.id = CAST(d.value AS INTEGER)
      WHERE si.site_id = ? AND d.day_ms >= ? AND d.day_ms < ? AND d.day_ms < r.next_day_ms
      GROUP BY d.dimension, value
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY total DESC, value ASC) AS rank FROM counts
    ) SELECT dimension, value, total FROM ranked WHERE rank <= 5 ORDER BY dimension, rank`,
    ).bind(siteId, start, end),
  ]);
  return {
    enabled: state.results.length > 0,
    month,
    rows: rows.results,
    retention: state.results[0] || null,
  };
}
