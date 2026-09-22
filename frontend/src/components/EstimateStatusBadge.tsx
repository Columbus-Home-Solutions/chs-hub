import { Badge } from "./ui/Badge";
import { formatStatus } from "../lib/format";
import {
  IMPORTED_SIGNED_BADGE,
  isJobberAcceptedImport,
} from "@chs/shared/jobber-accepted-import";

export function EstimateStatusBadge({
  status,
  dataSource,
}: {
  status: string | null | undefined;
  dataSource?: string | null;
}) {
  if (isJobberAcceptedImport(dataSource)) {
    return (
      <span class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
        <Badge status="jobber_accepted_import">{IMPORTED_SIGNED_BADGE}</Badge>
        {status === "approved" ? <Badge status="approved">{formatStatus("approved")}</Badge> : null}
      </span>
    );
  }
  return <Badge status={status ?? ""}>{formatStatus(status)}</Badge>;
}
