import type { AdminAuditRow } from "@kuutti/schema";

/** An audit row's detail as key and value (#309); nothing when it has none. */
export function AuditDetail({ detail }: { detail: AdminAuditRow["detail"] }) {
  const entries = Object.entries(detail ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground [&>div]:contents">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>
            <code>{key}</code>
          </dt>
          <dd>{value === null ? "–" : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
