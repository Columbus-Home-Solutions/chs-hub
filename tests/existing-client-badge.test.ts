import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(join(repoRoot, "src/routes/estimate-requests.ts"), "utf8");
const kanban = readFileSync(join(repoRoot, "frontend/src/views/estimating/CHSLeadsKanban.tsx"), "utf8");
const detail = readFileSync(join(repoRoot, "frontend/src/views/estimating/EstimateRequestDetail.tsx"), "utf8");

describe("Existing client badge", () => {
  it("is true only when the client already has a job, any source", () => {
    expect(route).toContain("SELECT 1 FROM jobs j WHERE j.client_id = er.client_id");
    expect(route).toContain("existing_client: (row.client_has_job ?? 0) === 1");
    expect(route).not.toContain("clientPredatesRequest");
    expect(route).not.toMatch(/j\.source|j\.data_source/);
  });

  it("only renders the badge from existing_client", () => {
    expect(kanban).toContain('{request.existing_client && <Badge tone="info">Existing client</Badge>}');
    expect(detail).toContain('{r.existing_client && <Badge tone="info">Existing client</Badge>}');
    expect(route).not.toMatch(/existing_client[\s\S]{0,80}status\s*=/);
  });
});
