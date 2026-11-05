/* eslint-disable */
// InsightFlare browser tracker SDK
// Compiled at build time; the script endpoint injects this config immediately
// before the SDK. Do not turn these values into build-time string placeholders:
// minifiers may constant-fold privacy branches before injection happens.

import { sanitizeLimitedPayload } from "../lib/tracker-contract/limited-analytics";

import { initAutoTrack } from "./auto-track";
import { createPerformanceTracker } from "./performance";
import type { UaClientHintsResult } from "./ua-client-hints";
import { readUaClientHints, withUaClientHints } from "./ua-client-hints";

const TRACKER_RUNTIME_CONFIG_KEY = "__insightflare_tracker_runtime_config__";

interface TrackerRuntimeConfig {
  siteId: string;
  isEUMode: boolean;
  limitedAnalytics?: boolean;
  trackQueryParams: boolean;
  trackHash: boolean;
  ignoreDoNotTrack: boolean;
  autoTrackOutboundLinks: boolean;
  performanceSampleRate: number;
  sessionWindowMs: number;
  collectToken: string;
}

function takeRuntimeConfig(): TrackerRuntimeConfig {
  const configHost = globalThis as typeof globalThis & Record<string, unknown>;
  const rawConfig = configHost[TRACKER_RUNTIME_CONFIG_KEY];
  delete configHost[TRACKER_RUNTIME_CONFIG_KEY];

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("InsightFlare: runtime configuration is missing");
  }

  const config = rawConfig as Partial<TrackerRuntimeConfig>;
  if (
    typeof config.siteId !== "string" ||
    typeof config.isEUMode !== "boolean" ||
    typeof config.trackQueryParams !== "boolean" ||
    typeof config.trackHash !== "boolean" ||
    typeof config.ignoreDoNotTrack !== "boolean" ||
    typeof config.autoTrackOutboundLinks !== "boolean" ||
    typeof config.performanceSampleRate !== "number" ||
    typeof config.sessionWindowMs !== "number" ||
    typeof config.collectToken !== "string"
  ) {
    throw new Error("InsightFlare: runtime configuration is invalid");
  }

  return config as TrackerRuntimeConfig;
}

// ── Static constants ──
const INSTALL_KEY = "__insightflare_tracker_v6__";
const ROUTE_SETTLE_DELAY_MS = 300;
const UA_CLIENT_HINT_TIMEOUT_MS = 200;

// ── Build-time flags (replaced by esbuild define) ──
declare var BUILD_PERFORMANCE: boolean;

// ── State variables ──
let currentVisit: {
  id: string;
  startedAt: number;
  href: string;
  routeKey: string;
  referrerUrl: string;
} | null = null;
let pendingRouteChange: {
  href: string;
  referrerUrl: string;
  transitionAt: number;
  routeKey: string;
} | null = null;
let routeChangeTimer = 0;
let leaveSent = false;
let pendingHiddenAt = 0;
let userIdentifiedId = "";
let userIdentifiedName = "";
let globalProperties: Record<string, unknown> = {};
let trackedOnce: Set<string> = new Set();
let debugEnabled = false;
let uaClientHints: unknown = null;
let uaClientHintsSettled = false;

// ── Entry guard ──
const scriptEl = document.currentScript;
if (!scriptEl || !(scriptEl instanceof HTMLScriptElement) || !scriptEl.src) {
  throw new Error("InsightFlare: script element not found");
}

if ((window as any)[INSTALL_KEY]) {
  throw new Error("InsightFlare: already installed");
}

const runtimeConfig = takeRuntimeConfig();
const SITE_ID = runtimeConfig.siteId;
const LIMITED_ANALYTICS = runtimeConfig.limitedAnalytics === true;
const IS_EU_MODE = LIMITED_ANALYTICS || runtimeConfig.isEUMode;
const TRACK_QUERY_PARAMS = runtimeConfig.trackQueryParams;
const TRACK_HASH = runtimeConfig.trackHash;
const IGNORE_DO_NOT_TRACK =
  !LIMITED_ANALYTICS && runtimeConfig.ignoreDoNotTrack;
const AUTO_TRACK_OUTBOUND_LINKS =
  !LIMITED_ANALYTICS && runtimeConfig.autoTrackOutboundLinks;
const PERFORMANCE_SAMPLE_RATE = runtimeConfig.performanceSampleRate;
const SESSION_WINDOW_MS = runtimeConfig.sessionWindowMs;
const COLLECT_TOKEN = runtimeConfig.collectToken;
const VISITOR_KEY = "__insightflare_visitor_" + SITE_ID + "__";

if (!IGNORE_DO_NOT_TRACK) {
  const dnt = String(navigator.doNotTrack || "")
    .trim()
    .toLowerCase();
  if (dnt === "1" || dnt === "yes") {
    throw new Error("InsightFlare: Do Not Track enabled");
  }
}

if (LIMITED_ANALYTICS) {
  try {
    window.localStorage.removeItem(VISITOR_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

const scriptUrl = new URL(scriptEl.src);
const collectUrl = new URL("/collect", scriptUrl.origin).toString();
let visitorId = IS_EU_MODE ? "" : loadOrCreateVisitorId(VISITOR_KEY);
const performanceTracker = createPerformanceTracker({
  enabled: BUILD_PERFORMANCE,
  sampleRate: PERFORMANCE_SAMPLE_RATE,
});

const uaClientHintsReady: Promise<UaClientHintsResult | null> =
  LIMITED_ANALYTICS
    ? Promise.resolve(null)
    : readUaClientHints()
        .then((hints) => {
          uaClientHints = hints;
          uaClientHintsSettled = true;
          return hints;
        })
        .catch(() => {
          uaClientHints = null;
          uaClientHintsSettled = true;
          return null;
        });

// ── Core utilities ──

function routeKey(href: string): string {
  const url = new URL(href, window.location.href);
  return [
    url.pathname || "/",
    TRACK_QUERY_PARAMS ? url.search || "" : "",
    TRACK_HASH ? url.hash || "" : "",
  ].join("|");
}

function loadOrCreateVisitorId(visitorKey: string): string {
  const existing = window.localStorage.getItem(visitorKey);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.localStorage.setItem(visitorKey, next);
  return next;
}

function rotateVisitorId(): void {
  if (LIMITED_ANALYTICS) {
    visitorId = "";
    return;
  }
  window.localStorage.removeItem(VISITOR_KEY);
  if (IS_EU_MODE) {
    visitorId = "";
    return;
  }
  visitorId = crypto.randomUUID();
  window.localStorage.setItem(VISITOR_KEY, visitorId);
}

function publicPageToken(href: string): string {
  if (
    SITE_ID !== "628631a7-ff2f-4f9c-aa11-df2fca9b2acb" ||
    location.hostname !== "newstake.ai"
  )
    return "";
  const url = new URL(href, location.href);
  for (const meta of document.querySelectorAll(
    'meta[name="insightflare-public-page"]',
  )) {
    const token = meta.getAttribute("content") || "";
    if (!token || token.length > 2048) continue;
    try {
      const part = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      const claim = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(part), (c) => c.charCodeAt(0)),
        ),
      );
      const search = Boolean((url.searchParams.get("q") || "").trim());
      if (
        claim.site === SITE_ID &&
        claim.host === "newstake.ai" &&
        Number.isSafeInteger(claim.exp) &&
        claim.exp >= Date.now() &&
        claim.path === url.pathname &&
        (claim.search === undefined || claim.search === search)
      )
        return token;
    } catch {
      /* Ignore invalid metadata. */
    }
  }
  return "";
}

let flushPendingPageview: ((useBeacon?: boolean) => void) | null = null;
function sendPageview(payload: any, href: string): void {
  const url = new URL(href, location.href);
  const expected =
    LIMITED_ANALYTICS &&
    SITE_ID === "628631a7-ff2f-4f9c-aa11-df2fca9b2acb" &&
    url.hostname === "newstake.ai" &&
    (url.pathname === "/" ||
      url.pathname === "/publications" ||
      /^\/sites\/topics\/[^/]+$/.test(url.pathname) ||
      (!new Set(["/sites/topics", "/sites/guides", "/sites/developers"]).has(
        url.pathname,
      ) &&
        /^\/(publications|people|companies|institutions|products|events|sites)\/[^/]+$/.test(
          url.pathname,
        )));
  const initial = expected ? publicPageToken(href) : "";
  if (!expected || initial || typeof MutationObserver === "undefined") {
    if (initial) payload.publicPageToken = initial;
    sendWhenUaClientHintsReady(payload, false);
    return;
  }
  let timer = 0;
  let sent = false;
  const observer = new MutationObserver(() => {
    if (publicPageToken(href)) flush();
  });
  const flush = (useBeacon = false) => {
    if (sent) return;
    sent = true;
    observer.disconnect();
    clearTimeout(timer);
    flushPendingPageview = null;
    const token = publicPageToken(href);
    if (token) payload.publicPageToken = token;
    send(payload, useBeacon);
  };
  flushPendingPageview = flush;
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content"],
  });
  timer = window.setTimeout(flush, 1000);
}

function pagePayloadBase(
  href: string,
  referrerUrl: string,
  startedAt: number,
  eventAt: number,
): any {
  const url = new URL(href, window.location.href);
  return {
    siteId: SITE_ID,
    visitId: currentVisit!.id,
    timestamp: eventAt,
    startedAt,
    pathname: url.pathname || "/",
    query: TRACK_QUERY_PARAMS ? url.search || "" : "",
    hash: TRACK_HASH ? url.hash || "" : "",
    hostname: url.hostname || "",
    title: document.title || "",
    language: navigator.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    screenWidth: (window.screen as any)?.width ?? null,
    screenHeight: (window.screen as any)?.height ?? null,
    referrerUrl: String(referrerUrl || ""),
    visitorId,
    ...(userIdentifiedId
      ? { userId: userIdentifiedId, userName: userIdentifiedName }
      : {}),
  };
}

function send(payload: any, useBeacon: boolean): void {
  let body = "";
  try {
    body = JSON.stringify(
      LIMITED_ANALYTICS
        ? {
            ...sanitizeLimitedPayload(payload),
            ...(payload.publicPageToken
              ? { publicPageToken: payload.publicPageToken }
              : {}),
            collectToken: COLLECT_TOKEN,
          }
        : withUaClientHints(
            { ...payload, collectToken: COLLECT_TOKEN },
            uaClientHints,
          ),
    );
  } catch {
    return;
  }
  if (useBeacon && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(
      collectUrl,
      new Blob([body], { type: "application/json" }),
    );
    return;
  }

  fetch(collectUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    mode: "cors",
    credentials: "omit",
    keepalive: useBeacon,
  }).catch(() => {});
}

function sendWhenUaClientHintsReady(payload: any, useBeacon: boolean): void {
  if (useBeacon || uaClientHintsSettled) {
    send(payload, useBeacon);
    return;
  }

  let sent = false;
  const flush = () => {
    if (sent) return;
    sent = true;
    send(payload, useBeacon);
  };
  uaClientHintsReady.then(flush, flush);
  window.setTimeout(flush, UA_CLIENT_HINT_TIMEOUT_MS);
}

// ── Visit lifecycle ──

function startVisit(
  href: string,
  referrerUrl: string,
  startedAt: number,
  navigation = "",
): void {
  flushPendingPageview?.();
  leaveSent = false;
  pendingHiddenAt = 0;
  currentVisit = {
    id: crypto.randomUUID(),
    startedAt,
    href,
    routeKey: routeKey(href),
    referrerUrl,
  };

  if (BUILD_PERFORMANCE && !performanceTracker.hasVisit()) {
    performanceTracker.start(currentVisit.id);
  }

  if (debugEnabled) {
    console.log(
      "[InsightFlare]",
      "pageview:",
      new URL(currentVisit.href, window.location.href).pathname || "/",
    );
  }
  sendPageview(
    {
      ...pagePayloadBase(
        currentVisit.href,
        currentVisit.referrerUrl,
        currentVisit.startedAt,
        currentVisit.startedAt,
      ),
      kind: "pageview",
      ...(navigation ? { navigation } : {}),
    },
    href,
  );
}

function expiredLimitedVisit(eventAt: number): boolean {
  if (!LIMITED_ANALYTICS || !currentVisit) return false;
  if (leaveSent) return true;
  if (
    Math.floor(currentVisit.startedAt / 86400000) ===
    Math.floor(eventAt / 86400000)
  )
    return false;
  leaveSent = true;
  pendingHiddenAt = 0;
  return true;
}

function endCurrentVisit(exitReason: string, useBeacon: boolean): void {
  flushPendingPageview?.(useBeacon);
  if (!currentVisit || leaveSent) return;
  if (expiredLimitedVisit(Date.now())) return;
  leaveSent = true;
  pendingHiddenAt = 0;
  const eventAt = Date.now();
  const url = new URL(currentVisit.href, window.location.href);
  const performancePayload = BUILD_PERFORMANCE
    ? performanceTracker.buildPayload()
    : null;
  send(
    {
      kind: "leave",
      siteId: SITE_ID,
      visitId: currentVisit.id,
      visitorId,
      timestamp: eventAt,
      durationMs: Math.max(0, eventAt - currentVisit.startedAt),
      pathname: url.pathname || "/",
      hostname: url.hostname || "",
      exitReason,
      ...(userIdentifiedId
        ? { userId: userIdentifiedId, userName: userIdentifiedName }
        : {}),
      ...(performancePayload || {}),
    },
    useBeacon,
  );
  if (BUILD_PERFORMANCE) performanceTracker.stop();
}

function sendLeave(): void {
  endCurrentVisit("pagehide", true);
}

function sendVisibility(
  visibilityState: "hidden" | "visible",
  eventAt: number,
): void {
  flushPendingPageview?.(true);
  if (!currentVisit || leaveSent) return;
  if (expiredLimitedVisit(eventAt)) return;
  const url = new URL(currentVisit.href, window.location.href);
  send(
    {
      kind: "visibility",
      siteId: SITE_ID,
      visitId: currentVisit.id,
      visitorId,
      visibilityState,
      timestamp: eventAt,
      pathname: url.pathname || "/",
      hostname: url.hostname || "",
      ...(userIdentifiedId
        ? { userId: userIdentifiedId, userName: userIdentifiedName }
        : {}),
    },
    true,
  );
}

function handleDocumentHidden(): void {
  flushPendingRouteChange();
  if (!currentVisit || leaveSent || pendingHiddenAt > 0) return;
  pendingHiddenAt = Date.now();
  sendVisibility("hidden", pendingHiddenAt);
}

function handleDocumentVisible(): void {
  if (!currentVisit || leaveSent || pendingHiddenAt <= 0) return;
  const eventAt = Date.now();
  if (expiredLimitedVisit(eventAt)) return;
  if (eventAt - pendingHiddenAt > SESSION_WINDOW_MS) {
    const referrerUrl = currentVisit.href;
    if (BUILD_PERFORMANCE) performanceTracker.stop();
    startVisit(window.location.href, referrerUrl, eventAt);
    return;
  }
  sendVisibility("visible", eventAt);
  pendingHiddenAt = 0;
}

function commitRouteChange(routeChange: {
  href: string;
  referrerUrl: string;
  transitionAt: number;
  routeKey: string;
}): void {
  pendingRouteChange = null;
  routeChangeTimer = 0;
  const nextKey = routeKey(routeChange.href);
  if (!currentVisit || nextKey === currentVisit.routeKey) return;
  startVisit(
    routeChange.href,
    routeChange.referrerUrl,
    routeChange.transitionAt,
    "route",
  );
}

function flushPendingRouteChange(): void {
  if (!pendingRouteChange) return;
  if (routeChangeTimer) {
    clearTimeout(routeChangeTimer);
    routeChangeTimer = 0;
  }
  commitRouteChange(pendingRouteChange);
}

function scheduleRouteChange(nextHref: string, nextReferrerUrl: string): void {
  const nextKey = routeKey(nextHref);
  if (!currentVisit || nextKey === currentVisit.routeKey) return;
  pendingRouteChange = {
    href: nextHref,
    referrerUrl: nextReferrerUrl,
    transitionAt: Date.now(),
    routeKey: nextKey,
  };
  if (routeChangeTimer) {
    clearTimeout(routeChangeTimer);
  }
  routeChangeTimer = window.setTimeout(() => {
    if (pendingRouteChange) {
      commitRouteChange(pendingRouteChange);
    }
  }, ROUTE_SETTLE_DELAY_MS);
}

function wrapHistoryMethod(methodName: "pushState" | "replaceState"): void {
  const original = history[methodName] as
    ((...args: any[]) => void) | undefined;
  if (!original) return;
  history[methodName] = function (this: any, ...args: any[]) {
    const result = original.apply(this, args);
    queueMicrotask(() => {
      scheduleRouteChange(
        window.location.href,
        currentVisit?.href || document.referrer || "",
      );
    });
    return result;
  } as any;
}

// ── Public API ──

function identify(userId: string, opts?: { name?: string }): void {
  if (LIMITED_ANALYTICS) return;
  const id = String(userId || "")
    .trim()
    .slice(0, 255);
  if (!id) return;
  const name = String(
    (opts && typeof opts === "object" && typeof opts.name === "string"
      ? opts.name
      : "") || "",
  )
    .trim()
    .slice(0, 255);
  userIdentifiedId = id;
  userIdentifiedName = name;
  if (!currentVisit) return;
  if (debugEnabled) {
    console.log(
      "[InsightFlare]",
      "identify:",
      JSON.stringify(id),
      name ? JSON.stringify(name) : "",
    );
  }
  flushPendingRouteChange();
  send(
    {
      ...pagePayloadBase(
        currentVisit.href,
        currentVisit.referrerUrl,
        currentVisit.startedAt,
        Date.now(),
      ),
      kind: "identify",
      userId: id,
      userName: name || "",
    },
    false,
  );
}

function reset(): void {
  if (LIMITED_ANALYTICS) return;
  flushPendingRouteChange();
  if (currentVisit) {
    endCurrentVisit("identity_reset", false);
  }
  userIdentifiedId = "";
  userIdentifiedName = "";
  rotateVisitorId();
  if (!currentVisit) return;
  startVisit(window.location.href, "", Date.now());
}

function setGlobalProperties(props: Record<string, unknown>): void {
  if (!props || typeof props !== "object" || Array.isArray(props)) return;
  for (const key in props) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    globalProperties[key] = props[key];
  }
}

function clearGlobalProperties(): void {
  globalProperties = {};
}

function trackOnce(eventName: string, eventData?: unknown): void {
  const normalizedName = String(eventName || "").trim();
  if (!normalizedName) return;
  if (trackedOnce.has(normalizedName)) return;
  trackedOnce.add(normalizedName);
  track(normalizedName, eventData);
}

function track(eventName: string, eventData?: unknown): void {
  const normalizedName = String(eventName || "").trim();
  if (!normalizedName || !currentVisit) return;
  if (debugEnabled) {
    console.log(
      "[InsightFlare]",
      "track:",
      JSON.stringify(normalizedName),
      JSON.stringify(
        Object.assign(
          {},
          globalProperties,
          eventData === undefined ? {} : eventData,
        ),
      ),
    );
  }
  flushPendingRouteChange();
  flushPendingPageview?.();
  if (expiredLimitedVisit(Date.now())) return;
  send(
    {
      ...pagePayloadBase(
        currentVisit.href,
        currentVisit.referrerUrl,
        currentVisit.startedAt,
        Date.now(),
      ),
      kind: "custom_event",
      eventId: crypto.randomUUID(),
      eventName: normalizedName,
      eventData: Object.assign(
        {},
        globalProperties,
        eventData === undefined ? {} : eventData,
      ),
    },
    false,
  );
}

function debug(): void {
  debugEnabled = true;
}

// ── Initialization ──

function startInitialVisitWhenReady(): void {
  const startInitialVisit = () => {
    startVisit(window.location.href, document.referrer || "", Date.now());
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startInitialVisit, {
      once: true,
    });
    return;
  }

  startInitialVisit();
}

startInitialVisitWhenReady();

wrapHistoryMethod("pushState");
wrapHistoryMethod("replaceState");
window.addEventListener("popstate", () => {
  scheduleRouteChange(
    window.location.href,
    currentVisit?.href || document.referrer || "",
  );
});
window.addEventListener("hashchange", () => {
  scheduleRouteChange(
    window.location.href,
    currentVisit?.href || document.referrer || "",
  );
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    handleDocumentHidden();
    return;
  }
  if (document.visibilityState === "visible") {
    handleDocumentVisible();
  }
});
window.addEventListener("pagehide", () => {
  flushPendingRouteChange();
  sendLeave();
});

initAutoTrack({ autoTrackOutboundLinks: AUTO_TRACK_OUTBOUND_LINKS, track });

// ── Window exposure ──
const api = {
  version: "6",
  siteId: SITE_ID,
  track,
  identify,
  reset,
  setGlobalProperties,
  clearGlobalProperties,
  trackOnce,
  debug,
};
(window as any)[INSTALL_KEY] = api;
(window as any).insightflare = api;
