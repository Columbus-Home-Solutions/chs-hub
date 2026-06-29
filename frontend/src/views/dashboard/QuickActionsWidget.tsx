import { go } from "../../lib/nav";

const ACTIONS = [
  { icon: "📋", label: "New Lead", path: "/estimating/new" },
  { icon: "📝", label: "New Estimate", path: "/estimates" },
  { icon: "💰", label: "Log Expense", path: "/financial?tab=expenses&action=new" },
  { icon: "📷", label: "Add Photo", path: "/photos?action=upload" },
  { icon: "🧾", label: "New Invoice", path: "/financial?tab=invoices&action=new" },
  { icon: "💬", label: "Send Message", path: "/clients?tab=messages" },
] as const;

export function QuickActionsWidget() {
  return (
    <div class="quick-actions">
      <div class="quick-actions__header">Quick Actions</div>
      <div class="quick-actions__grid">
        {ACTIONS.map((action) => (
          <button
            key={action.path}
            type="button"
            class="quick-actions__btn"
            onClick={() => go(action.path)}
          >
            <span class="quick-actions__btn-icon">{action.icon}</span>
            <span class="quick-actions__btn-label">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
