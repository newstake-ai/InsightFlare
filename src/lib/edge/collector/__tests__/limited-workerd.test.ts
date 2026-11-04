import { createRequire } from "node:module";

import * as esbuild from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "../../../../../scripts/schema/database";

const requireFromWrangler = createRequire(
  require.resolve("wrangler/package.json"),
);
const { Miniflare } = requireFromWrangler("miniflare");

describe("limited collector on workerd", () => {
  it("persists sanitized visits with stale settings and rejects old envelopes after restart", async () => {
    const bundle = await esbuild.build({
      stdin: {
        contents: `import { handleCollectRequest } from './src/lib/edge/collector/collect';
import { issueCollectToken } from './src/lib/edge/auth/collect-token';
export { IngestDurableObject } from './src/lib/edge/ingest/durable-object';
export default { async fetch(req,env,ctx) { const url = new URL(req.url); if (url.pathname === '/token') return new Response(await issueCollectToken({env,siteId:'site',ip:'198.51.100.1',hideIp:true})); return handleCollectRequest(req,env,ctx,url); } };`,
        resolveDir: process.cwd(),
        sourcefile: "limited-workerd.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:*", "node:*"],
    });
    const mf = new Miniflare({
      workers: [
        {
          config: {
            name: "test",
            compatibilityDate: "2026-10-19",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "index.js",
              modulesRoot: "/",
              modules: {
                "index.js": {
                  type: "esm",
                  contents: bundle.outputFiles[0].text,
                },
              },
            },
            exports: {
              IngestDurableObject: {
                type: "durable-object",
                storage: "sqlite",
              },
            },
            env: {
              INGEST_DO: {
                type: "durable-object",
                worker: "test",
                exportName: "IngestDurableObject",
              },
              DB: { type: "d1", id: "test-db" },
              SITE_SETTINGS_KV: { type: "kv", id: "test-kv" },
              MAIN_SECRET: {
                type: "text",
                value: "test-secret-test-secret-test-secret",
              },
              INSIGHTFLARE_E2E: { type: "text", value: "1" },
              REQUEST_ANALYTICS: {
                type: "analytics-engine-dataset",
                name: "requests",
              },
              TRAFFIC_ANALYTICS: {
                type: "analytics-engine-dataset",
                name: "traffic",
              },
              EVENT_ANALYTICS: {
                type: "analytics-engine-dataset",
                name: "events",
              },
            },
          },
        },
      ],
    });
    try {
      const db = await mf.getD1Database("DB");
      const migrated = createMigratedDatabase();
      const schema = migrated
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all() as { sql: string }[];
      migrated.close();
      for (const { sql } of schema) await db.prepare(sql).run();
      await db
        .prepare(
          "INSERT INTO users(id,email) VALUES('user','test@example.com')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO teams(id,name,slug,owner_user_id) VALUES('team','Team','team','user')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO sites(id,team_id,name,domain) VALUES('site','team','Site','example.com')",
        )
        .run();
      const kv = await mf.getKVNamespace("SITE_SETTINGS_KV");
      await kv.put(
        "site",
        JSON.stringify({
          siteId: "site",
          siteDomain: "example.com",
          limitedAnalytics: false,
          botProtectionEnabled: false,
        }),
      );
      await db
        .prepare(
          "INSERT INTO sites(id,team_id,name,domain) VALUES('occupied','team','Occupied','example.com')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO site_identities(site_pk, site_id) VALUES (2, 'occupied')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO visit_hourly_rollups(site_pk, site_id, hour_bucket, input_cutoff_ms) VALUES (2, 'occupied', 1, 1)",
        )
        .run();
      const ns = await mf.getDurableObjectNamespace("INGEST_DO");
      const occupied = ns.get(ns.idFromName("occupied"));
      expect(
        (
          await occupied.fetch("https://ingest.internal/enable-limited", {
            method: "POST",
            body: JSON.stringify({ siteId: "occupied" }),
          })
        ).status,
      ).toBe(409);

      const stub = ns.get(ns.idFromName("site"));
      expect(
        (
          await stub.fetch("https://ingest.internal/enable-limited", {
            method: "POST",
            body: JSON.stringify({ siteId: "site" }),
          })
        ).status,
      ).toBe(204);
      const token = await (
        await mf.dispatchFetch("https://collector.test/token")
      ).text();
      const payload = {
        kind: "pageview",
        siteId: "site",
        visitId: "00000000-0000-4000-8000-000000000001",
        collectToken: token,
        hostname: "example.com",
        pathname: "/article",
        title: "sensitive",
        query: "email=secret%40example.com&utm_source=newsletter",
        userId: "secret",
        timestamp: Date.now(),
      };
      expect(
        (
          await mf.dispatchFetch("https://collector.test/collect", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://example.com",
              "user-agent": "Mozilla/5.0",
              "cf-connecting-ip": "198.51.100.1",
            },
            body: JSON.stringify(payload),
          })
        ).status,
      ).toBe(204);
      await vi.waitFor(async () => {
        await stub.fetch("https://ingest.internal/flush?force=1", {
          method: "POST",
        });
        const row = await db
          .prepare("SELECT visit_id, title, user_id, query_string FROM visits")
          .first();
        expect(row).toMatchObject({
          title: "",
          user_id: null,
          query_string: "utm_source=newsletter",
        });
        expect(row.visit_id).not.toBe(payload.visitId);
      });
      await mf.unsafeEvictDurableObject("test", "IngestDurableObject", {
        name: "site",
      });
      expect(
        (
          await stub.fetch("https://ingest.internal/ingest", {
            method: "POST",
            body: JSON.stringify({
              client: payload,
              request: { receivedAt: Date.now() },
            }),
          })
        ).status,
      ).toBe(204);
      expect(
        (await db.prepare("SELECT count(*) AS n FROM visits").first()).n,
      ).toBe(1);
    } finally {
      await mf.dispose();
    }
  });
});
