// Cloud sync settings shared by index.html (TimeBudget) and tasks.html (daily tasks).
// Both pages sync into the same Firestore doc: users/{uid}/apps/planner
// Needs js/engine.js (global TB) loaded first.
import { startCloudSync } from "./cloud-sync.js";

const STORE_KEY = "timebudget:v1";

// Small snapshot of this week that other apps (the budget app) can read.
// Reads straight from localStorage so it works on either page.
function plannerSummary() {
  const TB = window.TB;
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { raw = null; }
  if (!TB || !raw) return null;
  const state = TB.sanitizeState(raw);
  const wk = TB.weekKey(new Date());
  const b = TB.computeBudget(state.weeks[wk] || TB.emptyPlan(), state.categories);
  const d = new Date();
  const dayKey = "planner-" + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  let tasks = [];
  try { tasks = JSON.parse(localStorage.getItem(dayKey)) || []; } catch (e) { tasks = []; }
  return {
    week: wk, fixed: b.fixed, discretionary: b.discretionary, allocated: b.allocated,
    unallocated: b.unallocated, overallocated: b.overallocated,
    tasksToday: tasks.length, tasksLeftToday: tasks.filter((t) => !t.done).length,
  };
}

export const sync = startCloudSync({
  appId: "planner",
  keys: [STORE_KEY],                 // weekly plan, categories, scenarios, history
  prefixes: ["planner-"],            // daily task lists (planner-YYYY-MM-DD)
  // timebudget:ui (open tab, chart series) stays per-device on purpose
  summary: plannerSummary,
  onRemoteChange: () => (window.plannerReload ? window.plannerReload() : location.reload()),
  pill: { bg: "#ffab2e", fg: "#1a1204" },
});
