import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

function rule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(start, close + 1);
}

describe("action required red", () => {
  it("aliases the job token to the existing error red", () => {
    const tokens = read("../frontend/src/styles/tokens.css");
    const line = tokens.split("\n").find((row) => row.includes("--job-action-required:"));
    expect(line).toBeDefined();
    expect(line).toContain("var(--color-error)");
    expect(line).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("paints the Kanban column, cards, and detail pill without touching other statuses", () => {
    const css = read("../frontend/src/styles/app.css");
    expect(rule(css, ".pipeline-col--action_required {")).toContain("var(--job-action-required)");
    expect(rule(css, ".pipeline-col--action_required .pipeline-col__title")).toContain("var(--job-action-required)");
    expect(rule(css, ".pipeline-col--action_required .er-card {")).toContain("var(--job-action-required)");
    expect(rule(css, ".job-status--action_required")).toContain("var(--job-action-required)");
    expect(rule(css, ".pipeline-col--deposit_paid")).toContain("var(--job-deposit-paid)");
    expect(rule(css, ".pipeline-col--scheduled")).toContain("var(--job-scheduled)");
    expect(rule(css, ".pipeline-col--in_progress")).toContain("var(--job-in-progress)");
    expect(rule(css, ".pipeline-col--punch_list")).toContain("var(--job-punch-list)");
    expect(rule(css, ".pipeline-col--complete")).toContain("var(--job-complete)");
    expect(rule(css, ".pipeline-col--closed")).toContain("var(--job-closed)");
    expect(rule(css, ".job-status--in_progress")).toContain("var(--job-in-progress)");
  });

  it("uses an outline badge so it does not match past due or the error toast", () => {
    const css = read("../frontend/src/styles/components.css");
    const action = rule(css, ".badge--action_required");
    expect(action).toContain("color: var(--color-error)");
    expect(action).toContain("background: transparent");
    expect(action).toContain("border-color: var(--color-error)");
    expect(action).not.toContain("error-subtle");
    const pastDue = rule(css, ".badge--error");
    expect(pastDue).toContain("var(--color-error-subtle)");
    expect(pastDue).toContain("var(--color-error-border)");
    const toast = rule(css, ".toast--error");
    expect(toast).toContain("background: var(--color-error)");
    expect(toast).toContain("color: white");
    expect(rule(css, ".badge--scheduled")).toContain("var(--status-scheduled)");
    expect(rule(css, ".badge--in_progress")).toContain("var(--status-in-progress)");
    const doc = read("../public/docs/CHS-Design-System.md");
    expect(doc).toContain(".badge--action_required { color: var(--color-error); background: transparent; border-color: var(--color-error); }");
    expect(doc).toContain(".badge--past_due      { color: var(--color-error); background: var(--color-error-subtle); border-color: var(--color-error-border); }");
  });
});
