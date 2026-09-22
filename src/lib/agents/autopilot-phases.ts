/** The eight phases of an autopilot cycle. Safe to import from client components. */
export const PHASES = [
  { id: "recall", label: "Recall", blurb: "Load what earlier cycles learned" },
  { id: "plan", label: "Plan", blurb: "sprint-planner commits the sprint" },
  { id: "automate", label: "Automate", blurb: "qe-pipeline writes specs per story" },
  { id: "execute", label: "Execute", blurb: "Run every generated test" },
  { id: "heal", label: "Heal", blurb: "qe-auto-heal repairs drift, escalates bugs" },
  { id: "review", label: "Review", blurb: "Check every criterion against evidence" },
  { id: "report", label: "Report", blurb: "cycle-reporter writes the summary" },
  { id: "learn", label: "Learn", blurb: "learner turns failures into lessons" },
] as const;
export type PhaseId = (typeof PHASES)[number]["id"];
