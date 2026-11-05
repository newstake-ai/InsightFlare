import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { loadMigrations } from "../../../../scripts/schema/database";

it("preserves existing analytics when upgrading to limited retention", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = loadMigrations();
    const target = "0045_limited_analytics_retention.sql";
    for (const migration of migrations.filter(({ file }) => file < target)) {
      db.exec(migration.sql);
    }
    db.exec(`
      INSERT INTO users (id, email) VALUES ('user', 'owner@example.com');
      INSERT INTO teams (id, name, slug, owner_user_id) VALUES ('team', 'Team', 'team', 'user');
      INSERT INTO sites (id, team_id, name, domain) VALUES ('site', 'team', 'Site', 'example.com');
      INSERT INTO site_identities (site_id) VALUES ('site');
      INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname)
      VALUES ('visit', 'site', (SELECT site_pk FROM site_identities WHERE site_id = 'site'), 'visitor', 'session', 'complete', 1, 1, '/', 'example.com');
    `);
    db.exec(migrations.find(({ file }) => file === target)!.sql);
    expect(db.prepare("SELECT visit_id FROM visits").all()).toEqual([
      { visit_id: "visit" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
