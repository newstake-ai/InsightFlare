import { describe, expect, it } from "vitest";

import { createLimitedEnvelope } from "@/lib/edge/collector/limited-envelope";
import { verifiedPublicPage } from "@/lib/edge/collector/public-page";

const siteId = "628631a7-ff2f-4f9c-aa11-df2fca9b2acb";
const secret = "a dedicated secret with at least 32 bytes";
const path = "/publications/0123456789abcdef01234567";
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function token(claim: Record<string, unknown>, keyText = secret) {
  const body = encode(new TextEncoder().encode(JSON.stringify(claim)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${body}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}
describe("verified public page", () => {
  it("accepts only signed, unexpired metadata for the configured site, host and path", async () => {
    const claim = {
      site: siteId,
      host: "newstake.ai",
      path,
      title: "Public article",
      exp: Date.now() + 60000,
    };
    const input = {
      siteId,
      hostname: "newstake.ai",
      pathname: "/publications/:redacted",
      publicPageToken: await token(claim),
    };
    expect(await verifiedPublicPage(input, secret)).toEqual({
      pathname: path,
      title: "Public article",
    });
    expect(await verifiedPublicPage(input, "wrong secret")).toBeNull();
    expect(
      await verifiedPublicPage({ ...input, hostname: "other.example" }, secret),
    ).toBeNull();
    expect(
      await verifiedPublicPage({ ...input, siteId: "other" }, secret),
    ).toBeNull();
    expect(
      await verifiedPublicPage(
        { ...input, pathname: "/people/:redacted" },
        secret,
      ),
    ).toBeNull();
    expect(
      await verifiedPublicPage(
        {
          ...input,
          publicPageToken: await token({ ...claim, exp: Date.now() - 1 }),
        },
        secret,
      ),
    ).toBeNull();
    expect(
      await verifiedPublicPage(
        {
          ...input,
          publicPageToken: await token({ ...claim, title: "forged" }, "wrong"),
        },
        secret,
      ),
    ).toBeNull();
  });
  it("strips metadata before buffering and uses it only on pageviews", async () => {
    const publicPageToken = await token({
      site: siteId,
      host: "newstake.ai",
      path,
      title: "Public article",
      exp: Date.now() + 60000,
    });
    const request = new Request("https://collector.example/collect");
    const trace = { id: "trace", source: "collect", acceptedAt: Date.now() };
    const input = {
      siteId,
      hostname: "newstake.ai",
      pathname: "/publications/:redacted",
      visitId: "visit",
      publicPageToken,
    };
    const page = await createLimitedEnvelope(
      request,
      { ...input, kind: "pageview" },
      trace,
      "visitor-secret",
      secret,
    );
    expect(page.client).toMatchObject({
      pathname: path,
      title: "Public article",
    });
    expect(JSON.stringify(page)).not.toContain(publicPageToken);
    const leave = await createLimitedEnvelope(
      request,
      { ...input, kind: "leave" },
      trace,
      "visitor-secret",
      secret,
    );
    expect(leave.client.pathname).toBe("/publications/:redacted");
    expect(leave.client.title).toBeUndefined();
    expect(JSON.stringify(leave)).not.toContain(publicPageToken);
  });

  it("rejects malformed and incorrectly scoped metadata", async () => {
    const claim = {
      site: siteId,
      host: "newstake.ai",
      path,
      title: "Public article",
      exp: Date.now() + 60000,
    };
    const input = {
      siteId,
      hostname: "newstake.ai",
      pathname: "/publications/:redacted",
    };
    for (const publicPageToken of [
      "invalid",
      "a.b.c",
      "a.a",
      "x".repeat(2049),
      await token({ ...claim, site: "another-site" }),
      await token({ ...claim, host: "other.example" }),
      await token({ ...claim, title: "" }),
      await token({ ...claim, exp: Date.now() + 90000000 }),
    ]) {
      expect(
        await verifiedPublicPage({ ...input, publicPageToken }, secret),
      ).toBeNull();
    }
    expect(await verifiedPublicPage(input, undefined)).toBeNull();
  });

  it.each([
    ["/people/public-person", "/people/:redacted"],
    ["/sites/public-guide", "/sites/:redacted"],
    ["/sites/topics/ai-models", "/sites/topics/:redacted"],
  ])("accepts verified metadata for %s", async (path, pathname) => {
    const publicPageToken = await token({
      site: siteId,
      host: "newstake.ai",
      path,
      title: "Public page",
      exp: Date.now() + 60000,
    });
    expect(
      await verifiedPublicPage(
        { siteId, hostname: "newstake.ai", pathname, publicPageToken },
        secret,
      ),
    ).toEqual({ pathname: path, title: "Public page" });
  });
});

describe("Newstake limited path grouping", () => {
  it("groups unknown paths and is idempotent without changing other sites", async () => {
    const { sanitizeLimitedPayload } =
      await import("@/lib/tracker-contract/limited-analytics");
    const publication = sanitizeLimitedPayload({ siteId, pathname: path });
    expect(publication.pathname).toBe("/publications/:redacted");
    expect(sanitizeLimitedPayload(publication).pathname).toBe(
      publication.pathname,
    );
    expect(
      sanitizeLimitedPayload({ siteId, pathname: "/private-name" }).pathname,
    ).toBe("/:redacted");
    expect(
      sanitizeLimitedPayload({
        siteId: "another-site",
        pathname: "/private-name",
      }).pathname,
    ).toBe("/private-name");
  });
});
