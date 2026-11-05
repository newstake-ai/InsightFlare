import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  readRetentionConfig,
  writeRetentionConfig,
} from "@/lib/edge/scheduled-tasks/retention-config";
import { DEFAULT_RETENTION_CONFIG } from "@/lib/retention";

it("persists normalized retention settings and falls back when storage is unavailable", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const env = { DB: createSqliteD1Database(sqlite) };
    expect(await readRetentionConfig(env)).toEqual(DEFAULT_RETENTION_CONFIG);
    sqlite.exec(`CREATE TABLE configs (
      config_key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const settings = { ...DEFAULT_RETENTION_CONFIG, scheduledTaskLogsDays: 14 };
    expect(await writeRetentionConfig(env, settings)).toEqual(settings);
    expect(await readRetentionConfig(env)).toEqual(settings);
  } finally {
    sqlite.close();
  }
});
