export const releases = [
  { name: "Onboarding checklist", owner: "Maya", status: "In review", done: 6, total: 8 },
  { name: "Activity feed", owner: "Alex", status: "Building", done: 3, total: 7 },
  { name: "Keyboard navigation", owner: "Sam", status: "Ready", done: 5, total: 5 },
];

export function progress(done, total) {
  if (total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(done, total)) / total * 100);
}
