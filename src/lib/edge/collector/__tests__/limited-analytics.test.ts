import { describe, expect, it } from "vitest";

import { sanitizeLimitedPayload } from "@/lib/tracker-contract/limited-analytics";

describe("limited analytics", () => {
  it("treats malformed optional fields as empty instead of retaining them", () => {
    expect(sanitizeLimitedPayload({ referrerUrl: 42 } as never)).toEqual({
      referrerUrl: "",
    });
    const malformed = {
      pathname: 42,
      query: "",
      referrerUrl: "not a url",
      eventData: [],
    };
    expect(sanitizeLimitedPayload(malformed as never)).toEqual({
      pathname: "/",
      query: "",
      referrerUrl: "",
      eventData: {},
    });
    expect(
      sanitizeLimitedPayload({
        query: "utm_source=&utm_medium=email",
        eventData: { target_domain: "EXAMPLE.COM", action: "click" },
      }),
    ).toEqual({
      query: "utm_medium=email",
      eventData: { target_domain: "example.com", action: "click" },
    });
  });

  it("redacts identifier-like paths and unapproved campaign and event data", () => {
    expect(
      sanitizeLimitedPayload({
        pathname: "/users/123456789/%ZZ",
        query:
          "utm_source=user%40example.com&utm_medium=email&utm_campaign=abcdef1234567890abcdef1234567890&private=secret",
        referrerUrl: "javascript:alert(1)",
        eventName: "unapproved",
        eventData: {
          action: "unapproved",
          target_domain: "invalid/domain",
          target_path: "/users/123456789?token=secret",
        },
      }),
    ).toEqual({
      pathname: "/users/:redacted/:redacted",
      query: "utm_medium=email",
      referrerUrl: "",
      eventName: "",
      eventData: { target_path: "/users/:redacted" },
    });
  });
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
  it("scopes event identifiers by site and day while dropping client timestamps", async () => {
    const request = new Request("https://collector.example/collect");
    const trace = {
      id: "trace",
      source: "collect",
      acceptedAt: Date.UTC(2026, 0, 1),
    };
    const payload = {
      kind: "custom_event" as const,
      siteId: "site-a",
      visitId: "visit",
      eventId: "event",
      startedAt: 1,
      timestamp: 1,
      eventName: "click",
    };
    const first = await createLimitedEnvelope(
      request,
      payload,
      trace,
      "test-secret",
    );
    const same = await createLimitedEnvelope(
      request,
      payload,
      trace,
      "test-secret",
    );
    const otherSite = await createLimitedEnvelope(
      request,
      { ...payload, siteId: "site-b" },
      trace,
      "test-secret",
    );
    expect(first.client.timestamp).toBe(trace.acceptedAt);
    expect(first.client.startedAt).toBeUndefined();
    expect(first.client.eventId).toBe(same.client.eventId);
    expect(first.client.eventId).not.toBe(payload.eventId);
    expect(first.client.eventId).not.toBe(otherSite.client.eventId);
    expect(first.limited.visitorId).not.toBe(otherSite.limited.visitorId);
  });

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
