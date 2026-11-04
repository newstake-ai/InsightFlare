import type { TrackerClientPayload } from "@/lib/edge/types";

const SAFE_TEXT = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/;
const EVENT_NAMES = new Set(["outbound_click", "click", "signup", "upgrade"]);
const ACTIONS = new Set(["open", "click", "signup", "upgrade"]);
const SAFE_DOMAIN = /^(?=.{1,253}$)[a-z0-9.-]+$/;

function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (!SAFE_TEXT.test(value) || /[a-f0-9]{24,}/i.test(value)) return "";
  return value;
}

function cleanPath(input: unknown): string {
  if (typeof input !== "string") return "/";
  const path = input.split(/[?#]/, 1)[0] || "/";
  const segments = path.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return ":redacted";
    }
    if (!decoded) return "";
    if (
      !/^[a-zA-Z0-9._~-]{1,80}$/.test(decoded) ||
      /[a-f0-9]{16,}/i.test(decoded) ||
      /\d{6,}/.test(decoded)
    )
      return ":redacted";
    return segment;
  });
  const result = segments.join("/");
  return (result.startsWith("/") ? result : `/${result}`).slice(0, 512);
}

function cleanQuery(input: unknown): string {
  const inputParams = new URLSearchParams(
    typeof input === "string" ? input : "",
  );
  const output = new URLSearchParams();
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const value = cleanText(inputParams.get(key));
    if (value) output.set(key, value);
  }
  return output.toString();
}

function cleanReferrer(input: unknown): string {
  if (typeof input !== "string") return "";
  try {
    const url = new URL(input);
    return /^https?:$/.test(url.protocol) && SAFE_DOMAIN.test(url.hostname)
      ? `${url.protocol}//${url.hostname}/`
      : "";
  } catch {
    return "";
  }
}

function cleanEventData(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const data = input as Record<string, unknown>;
  const result: Record<string, string> = {};
  const action = cleanText(data.action);
  if (ACTIONS.has(action)) result.action = action;
  if (
    typeof data.target_domain === "string" &&
    SAFE_DOMAIN.test(data.target_domain.toLowerCase())
  )
    result.target_domain = data.target_domain.toLowerCase();
  if (typeof data.target_path === "string")
    result.target_path = cleanPath(data.target_path);
  return result;
}

export function sanitizeLimitedPayload(
  input: TrackerClientPayload,
): TrackerClientPayload {
  const result: TrackerClientPayload = {};
  for (const key of [
    "kind",
    "siteId",
    "visitId",
    "eventId",
    "timestamp",
    "startedAt",
    "navigation",
    "visibilityState",
    "durationMs",
    "exitReason",
    "hostname",
  ] as const) {
    if (input[key] !== undefined) Object.assign(result, { [key]: input[key] });
  }
  if (input.pathname !== undefined) result.pathname = cleanPath(input.pathname);
  if (input.query !== undefined) result.query = cleanQuery(input.query);
  if (input.referrerUrl !== undefined)
    result.referrerUrl = cleanReferrer(input.referrerUrl);
  if (input.eventName !== undefined) {
    const eventName = cleanText(input.eventName);
    result.eventName = EVENT_NAMES.has(eventName) ? eventName : "";
  }
  if (input.eventData !== undefined)
    result.eventData = cleanEventData(input.eventData);
  return result;
}
