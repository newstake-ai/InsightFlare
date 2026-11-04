import { describe, expect, it } from "vitest";

import { sanitizeLimitedPayload } from "@/lib/edge/collector/limited-analytics";

describe("limited analytics", () => {
  it("retains approved campaign and event fields without client identity or URL parameters", () => {
    expect(
      sanitizeLimitedPayload({
        kind: "custom_event",
        siteId: "site",
        visitId: "visit",
        eventId: "event",
        hostname: "newstake.ai",
        pathname: "/stories/example?token=secret",
        query:
          "?utm_source=campaign&utm_medium=email&utm_campaign=launch&search=private",
        referrerUrl: "https://example.com/private?q=secret",
        userId: "alice",
        visitorId: "persistent",
        eventName: "outbound_click",
        eventData: {
          action: "open",
          target_domain: "example.com",
          email: "a@example.com",
        },
      }),
    ).toEqual({
      kind: "custom_event",
      siteId: "site",
      visitId: "visit",
      eventId: "event",
      hostname: "newstake.ai",
      pathname: "/stories/example",
      query: "utm_source=campaign&utm_medium=email&utm_campaign=launch",
      referrerUrl: "https://example.com/",
      eventName: "outbound_click",
      eventData: { action: "open", target_domain: "example.com" },
    });
  });
});

import { normalizeSiteScriptSettings } from "@/lib/site-settings";

describe("limited analytics site setting", () => {
  it("defaults to disabled and can be enabled explicitly", () => {
    expect(normalizeSiteScriptSettings({}).limitedAnalytics).toBe(false);
    expect(
      normalizeSiteScriptSettings({ limitedAnalytics: true }).limitedAnalytics,
    ).toBe(true);
  });
});

import { createLimitedEnvelope } from "@/lib/edge/collector/limited-envelope";

describe("limited collector envelope", () => {
  it("converts request identity into site-scoped daily values before durable buffering", async () => {
    const request = new Request(
      "https://collector.example/collect?secret=token",
      {
        headers: {
          "user-agent": "private-agent",
          "cf-connecting-ip": "192.0.2.2",
          cookie: "private",
        },
      },
    );
    const payload = {
      siteId: "site",
      kind: "pageview" as const,
      visitId: "client-id",
      hostname: "example.com",
      pathname: "/article?private=1",
      userId: "alice",
    };
    const trace = {
      id: "trace",
      source: "collect",
      acceptedAt: Date.UTC(2026, 0, 1),
    };
    const envelope = await createLimitedEnvelope(
      request,
      payload,
      trace,
      "secret",
    );
    expect(envelope).toEqual({
      request: {
        method: "POST",
        url: "https://collector.invalid/collect",
        headers: {},
        cf: {},
        body: "",
        receivedAt: trace.acceptedAt,
      },
      client: {
        siteId: "site",
        kind: "pageview",
        visitId: expect.any(String),
        hostname: "example.com",
        pathname: "/article",
        timestamp: trace.acceptedAt,
        startedAt: trace.acceptedAt,
      },
      trace,
      limited: {
        visitorId: expect.any(String),
        browser: "",
        os: "",
        deviceType: "desktop",
      },
    });
    const nextDay = await createLimitedEnvelope(
      request,
      payload,
      { ...trace, acceptedAt: trace.acceptedAt + 86400000 },
      "secret",
    );
    expect(nextDay.limited.visitorId).not.toBe(envelope.limited.visitorId);
    expect(nextDay.client.visitId).not.toBe(envelope.client.visitId);
  });
});
