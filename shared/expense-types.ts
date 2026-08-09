/**
 * Canonical CHS expense-type options — single source of truth for the expense
 * form and the QBO expense-type → Account mapping screen.
 */

export const EXPENSE_TYPE_OPTIONS = [
  { value: "material", label: "Material" },
  { value: "subcontractor", label: "Subcontractor" },
  { value: "labor", label: "Labor" },
  { value: "permit", label: "Permit" },
  { value: "equipment", label: "Equipment" },
  { value: "vehicle", label: "Vehicle / Fuel" },
  { value: "other", label: "Other" },
] as const;

export type ExpenseTypeValue = (typeof EXPENSE_TYPE_OPTIONS)[number]["value"];

export const EXPENSE_TYPE_VALUES: readonly ExpenseTypeValue[] = EXPENSE_TYPE_OPTIONS.map(
  (o) => o.value,
);

/** Outside person/vendor paid — project-priced sub or day-rate labor (1099). */
export function expenseTypeAllowsVendorLink(expenseType: string | null | undefined): boolean {
  return expenseType === "subcontractor" || expenseType === "labor";
}
