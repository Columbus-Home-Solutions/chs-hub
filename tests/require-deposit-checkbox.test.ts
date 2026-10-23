import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyTypedDeposit,
  clearDepositPatch,
  depositEnabledToast,
  depositZeroNote,
  enableDepositPatch,
  requireDepositChecked,
  type DepositFlagFields,
} from "../frontend/src/lib/estimate-milestones";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const blank: DepositFlagFields = {
  deposit_amount: 0,
  deposit_type: "fixed",
  deposit_percentage: null,
};

describe("require deposit checkbox", () => {
  it("stays checked after a $0 save and reload", () => {
    const saved = enableDepositPatch(0);
    expect(saved).toEqual({
      deposit_amount: 0,
      deposit_type: "percentage",
      deposit_percentage: 33,
    });
    expect(requireDepositChecked(saved)).toBe(true);
    expect(depositZeroNote(saved)).toBe("Deposit will be 33% once line items are priced");
    expect(depositEnabledToast(0)).toBe(
      "Deposit enabled. It will be 33% once line items are priced.",
    );
  });

  it("stays unchecked after clearing the percentage and the amount", () => {
    const saved = clearDepositPatch();
    expect(saved).toEqual(blank);
    expect(requireDepositChecked(saved)).toBe(false);
    expect(depositZeroNote(saved)).toBeNull();
  });

  it("keeps a typed fixed amount checked and leaves the percentage stored", () => {
    const priced = enableDepositPatch(900);
    expect(priced.deposit_amount).toBe(297);
    const typed = applyTypedDeposit(priced, 250);
    expect(typed.deposit_amount).toBe(250);
    expect(typed.deposit_type).toBe("fixed");
    expect(typed.deposit_percentage).toBe(33);
    expect(requireDepositChecked(typed)).toBe(true);
    expect(depositZeroNote(typed)).toBeNull();
    expect(depositEnabledToast(900)).toBe("Deposit enabled");
  });

  it("shows a legacy percentage-and-$0 row as checked with that percentage", () => {
    const legacy: DepositFlagFields = {
      deposit_amount: 0,
      deposit_type: "percentage",
      deposit_percentage: 33,
    };
    expect(requireDepositChecked(legacy)).toBe(true);
    expect(depositZeroNote(legacy)).toBe("Deposit will be 33% once line items are priced");

    const otherPercent = { ...legacy, deposit_percentage: 25 };
    expect(requireDepositChecked(otherPercent)).toBe(true);
    expect(depositZeroNote(otherPercent)).toBe("Deposit will be 25% once line items are priced");
  });

  it("treats a typed $0 as still checked when the percentage was not cleared", () => {
    const typedZero = applyTypedDeposit(
      { deposit_amount: 250, deposit_type: "percentage", deposit_percentage: 33 },
      0,
    );
    expect(typedZero.deposit_type).toBe("fixed");
    expect(typedZero.deposit_percentage).toBe(33);
    expect(requireDepositChecked(typedZero)).toBe(true);
    expect(depositZeroNote(typedZero)).toBe("Deposit set to $0");
  });

  it("uses the percentage note only while the deposit is still a percentage", () => {
    expect(
      depositZeroNote({ deposit_amount: 0, deposit_type: "percentage", deposit_percentage: 33 }),
    ).toBe("Deposit will be 33% once line items are priced");
    expect(
      depositZeroNote({ deposit_amount: 0, deposit_type: "fixed", deposit_percentage: 33 }),
    ).toBe("Deposit set to $0");
    expect(
      depositZeroNote({ deposit_amount: 0, deposit_type: "fixed", deposit_percentage: null }),
    ).toBeNull();
  });
});

describe("require deposit wiring", () => {
  const builder = read("frontend/src/views/estimating/EstimateBuilder.tsx");
  const card = builder.slice(
    builder.indexOf("function PerLineItemDeposit"),
    builder.indexOf("function PaymentScheduleBuilder"),
  );
  const send = builder.slice(builder.indexOf("function SendButton"), builder.indexOf("function PerLineItemDeposit") > 0 ? builder.length : builder.length);

  it("binds the card to the percentage-or-amount rule and the $0 note", () => {
    expect(card).toContain("requireDepositChecked(displayed)");
    expect(card).toContain("depositZeroNote(displayed)");
    expect(card).toContain("enableDepositPatch(estimate.total)");
    expect(card).toContain("clearDepositPatch()");
    expect(card).toContain("applyTypedDeposit(");
    expect(card).not.toContain("(estimate.deposit_amount ?? 0) > 0");
  });

  it("leaves Send pre-flight on the dollar amount", () => {
    const sendFn = send.slice(send.indexOf("function SendButton"));
    expect(sendFn).toContain("standaloneDepositConfigured = (estimate.deposit_amount ?? 0) > 0");
    expect(sendFn).toContain("const depositOk = perLineItem || scheduleDepositConfigured");
    expect(sendFn).toContain("No deposit required");
    expect(sendFn).not.toContain("requireDepositChecked");
  });
});
