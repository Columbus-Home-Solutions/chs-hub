import { useRouter, type RoutableProps } from "preact-router";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { formatCurrency, formatDate } from "../../lib/format";
import { settlementText, type LaborSettlement } from "./labor-shared";

interface StatementLine {
  work_date: string;
  job_label: string;
  days: number;
  day_rate: number;
  amount: number;
  status?: "paid" | "unpaid";
  pay_date?: string | null;
  method?: string | null;
  settlement?: LaborSettlement | null;
}

interface Statement {
  sub_id: string;
  name: string;
  days: number;
  total: number;
  earned?: number;
  paid?: number;
  owed?: number;
  lines: StatementLine[];
}

interface StatementsResponse {
  company_name: string;
  week_start?: string;
  week_end?: string;
  pay_date?: string;
  paid?: boolean;
  from?: string | null;
  to?: string | null;
  statements: Statement[];
}

export function LaborStatement(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const params = new URLSearchParams(search);
  const week = params.get("week") ?? "";
  const sub = params.get("sub_id");
  const from = params.get("from") ?? "";
  const toDate = params.get("to") ?? "";
  const range = Boolean(from || toDate || (sub && !week));
  const query = range
    ? `/api/labor/statements?${params.toString()}`
    : `/api/labor/week/${week}/statements${sub ? `?sub_id=${encodeURIComponent(sub)}` : ""}`;
  const { data, loading, error } = useApi<StatementsResponse>(range || week ? query : null);

  if (!week && !range) return <p>Choose a week to print.</p>;
  if (loading) return <Spinner />;
  if (error) return <p class="form-error">{error}</p>;
  if (!data) return null;

  return (
    <div class="labor-statement">
      <div class="labor-no-print" style={{ marginBottom: "var(--space-md)" }}>
        <Button type="button" onClick={() => window.print()}>
          Print / Save PDF
        </Button>
      </div>
      {data.statements.length === 0 && <p>No labor logged this week.</p>}
      {data.statements.map((statement) => (
        <section key={statement.sub_id} class="labor-statement__page">
          <h1>{data.company_name}</h1>
          <h2>{range ? "Settlement statement" : "Weekly labor statement"} — {statement.name}</h2>
          {data.week_start && data.week_end && (
            <p>
              Week {formatDate(data.week_start)} – {formatDate(data.week_end)}
            </p>
          )}
          {range && (
            <p>
              {data.from ? formatDate(data.from) : "All time"}
              {data.to ? ` – ${formatDate(data.to)}` : ""}
            </p>
          )}
          {data.pay_date && (
            <p>{data.paid ? `PAID ${formatDate(data.pay_date)}` : `Pay date ${formatDate(data.pay_date)}`}</p>
          )}
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Job</th>
                <th class="num">Days</th>
                <th class="num">Rate</th>
                <th class="num">Amount</th>
                {range && <th>Status</th>}
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line, index) => (
                <tr key={`${line.work_date}-${index}`}>
                  <td>{formatDate(line.work_date)}</td>
                  <td>{line.job_label}</td>
                  <td class="num">{line.days}</td>
                  <td class="num">{formatCurrency(line.day_rate)}</td>
                  <td class="num">{formatCurrency(line.amount)}</td>
                  {range && (
                    <td>
                      {line.status === "paid"
                        ? `Paid${line.pay_date ? ` ${formatDate(line.pay_date)}` : ""}${line.method ? ` · ${line.method}` : ""}`
                        : "Unpaid"}
                      {settlementText(line.settlement) && <div>{settlementText(line.settlement)}</div>}
                    </td>
                  )}
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  <strong>{range ? "Earned" : "Week total"}</strong>
                </td>
                <td class="num">
                  <strong>{statement.days}</strong>
                </td>
                <td />
                <td class="num">
                  <strong>{formatCurrency(statement.earned ?? statement.total)}</strong>
                </td>
                {range && <td />}
              </tr>
              {range && (
                <tr>
                  <td colSpan={4}>
                    <strong>Paid {formatCurrency(statement.paid ?? 0)} · Still owed {formatCurrency(statement.owed ?? 0)}</strong>
                  </td>
                  <td />
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
