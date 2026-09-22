import { Badge } from "../ui/Badge";
import { useUntouchedLeads } from "../../hooks/useUntouchedLeads";

/** New Lead count. Hidden at zero. Amber when the oldest is more than an hour old. */
export function UntouchedLeadsBadge() {
  const { count, amber } = useUntouchedLeads();
  if (count <= 0) return null;
  return (
    <Badge tone={amber ? "warning" : "neutral"}>
      {String(count)}
    </Badge>
  );
}
