import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { useQuery } from "@tanstack/react-query";

type HistoryRow = { dimension: string; value: string; total: number };
type History = {
  enabled: boolean;
  rows: HistoryRow[];
  retention: { lastError: string | null } | null;
};

export function LimitedHistory({ siteId }: { siteId: string }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
      .toISOString()
      .slice(0, 7);
  });
  const query = useQuery({
    queryKey: ["limited-history", siteId, month],
    queryFn: async (): Promise<History> => {
      const params = new URLSearchParams({ siteId, month });
      const response = await fetch(`/api/private/limited-history?${params}`);
      if (!response.ok) throw new Error("Unable to load historical counts");
      return response.json();
    },
  });
  if (!query.data?.enabled && !query.isError) return null;
  const labels: Record<string, string> = {
    views: "Pageviews",
    path: "Pages",
    referrer: "Referrers",
    campaign: "Campaigns",
    event_total: "Total events",
    events: "Events",
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Historical daily counts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Completed UTC days only. Counts are separate from the dashboard above
          and do not include unique visitors.
        </p>
        <label className="flex items-center gap-2 text-sm">
          Month{" "}
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="rounded border bg-background px-2 py-1"
          />
        </label>
        {query.isError ? (
          <p role="alert">Unable to load historical counts.</p>
        ) : null}
        {query.data?.retention?.lastError ? (
          <p role="status">
            Retention cleanup is pending; recent history may be incomplete.
          </p>
        ) : null}
        {query.data?.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No completed daily counts for this month.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(labels).map(([key, label]) => {
            const rows =
              query.data?.rows.filter((row) => row.dimension === key) || [];
            if (!rows.length) return null;
            return (
              <section key={key}>
                <h3 className="font-medium">{label}</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {rows.map((row) => (
                    <li key={row.value} className="flex justify-between gap-3">
                      <span className="break-all">{row.value || "Total"}</span>
                      <span>{row.total.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Up to five values per category are shown. Dimension counts omit values
          with fewer than three occurrences per day.
        </p>
      </CardContent>
    </Card>
  );
}
