export type TrackerPayloadKind =
  "pageview" | "leave" | "visibility" | "custom_event" | "identify";

export interface TrackerPerformancePayload {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  cls?: number;
  inp?: number;
}

export interface TrackerUaBrandVersion {
  brand?: string;
  version?: string;
}

export interface TrackerUaClientHints {
  brands?: TrackerUaBrandVersion[];
  fullVersionList?: TrackerUaBrandVersion[];
  mobile?: boolean;
  platform?: string;
  platformVersion?: string;
  model?: string;
  formFactors?: string[];
}

export interface TrackerClientPayload {
  siteId?: string;
  kind?: TrackerPayloadKind;
  visitId?: string;
  previousVisitId?: string;
  performanceVisitId?: string;
  eventId?: string;
  sequence?: number;
  navigation?: string;
  timestamp?: number;
  startedAt?: number;
  pathname?: string;
  query?: string;
  hash?: string;
  hostname?: string;
  title?: string;
  language?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  referrerUrl?: string;
  visitorId?: string;
  userId?: string;
  userName?: string;
  durationMs?: number;
  exitReason?: string;
  visibilityState?: string;
  eventName?: string;
  eventData?: unknown;
  performance?: TrackerPerformancePayload;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  uaClientHints?: TrackerUaClientHints;
  collectToken?: string;
  publicPageToken?: string;
}
