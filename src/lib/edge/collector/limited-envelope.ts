import { UAParser } from "ua-parser-js";

import type {
  IngestTracePayload,
  TrackerClientPayload,
} from "@/lib/edge/types";
import { sanitizeLimitedPayload } from "@/lib/tracker-contract/limited-analytics";

import { verifiedPublicPage } from "./public-page";

async function keyedHash(secret: string, parts: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function createLimitedEnvelope(
  request: Request,
  input: TrackerClientPayload,
  trace: IngestTracePayload,
  secret: string,
  pageSecret?: string,
) {
  const day = new Date(trace.acceptedAt).toISOString().slice(0, 10);
  const siteId = input.siteId || "";
  const ua = new UAParser(request.headers.get("user-agent") || "").getResult();
  const browser = ua.browser.name || "";
  const os = ua.os.name || "";
  const deviceType = ua.device.type || "desktop";
  const visitorId = await keyedHash(secret, [
    "limited-visitor-v1",
    siteId,
    day,
    request.headers.get("cf-connecting-ip") || "",
    browser,
    os,
    deviceType,
  ]);
  const client = sanitizeLimitedPayload(input);
  const publicPage =
    input.kind === "pageview"
      ? await verifiedPublicPage(input, pageSecret)
      : null;
  if (publicPage) Object.assign(client, publicPage);
  else if (
    input.kind === "pageview" &&
    input.siteId === "628631a7-ff2f-4f9c-aa11-df2fca9b2acb" &&
    input.hostname === "newstake.ai"
  ) {
    const labels: Record<string, string> = {
      "/": "Publications",
      "/publications": "Publications",
      "/about": "About",
      "/privacy": "Privacy",
      "/feedback": "Feedback",
      "/people": "People",
      "/companies": "Companies",
      "/institutions": "Institutions",
      "/products": "Products",
      "/events": "Events",
      "/entities": "Entities",
      "/sites": "Sites",
      "/sites/guides": "Guides",
      "/sites/developers": "Developers",
      "/sites/topics": "Topics",
    };
    const title = labels[client.pathname || ""];
    if (title) client.title = title;
  }
  client.timestamp = trace.acceptedAt;
  if (client.kind === "pageview") client.startedAt = trace.acceptedAt;
  else delete client.startedAt;
  client.visitId = await keyedHash(secret, [
    "limited-visit-v1",
    siteId,
    day,
    input.visitId || "",
  ]);
  if (input.eventId)
    client.eventId = await keyedHash(secret, [
      "limited-event-v1",
      siteId,
      day,
      input.eventId,
    ]);
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country =
    typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country)
      ? cf.country
      : "";
  return {
    request: {
      method: "POST",
      url: "https://collector.invalid/collect",
      headers: {},
      cf: country ? { country } : {},
      body: "",
      receivedAt: trace.acceptedAt,
    },
    client,
    trace,
    limited: { visitorId, browser, os, deviceType },
  };
}
