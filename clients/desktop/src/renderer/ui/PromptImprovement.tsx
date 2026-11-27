import { useState } from "react";
import type { AssistantPromptImproverTarget } from "@termloop/contract/current";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import { Icon } from "./Icon.js";

export type PromptImprovement = {
  start(target: AssistantPromptImproverTarget, selection?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
};

/** User-facing action copy names the scope being changed. The same target must
    read the same way on its editor button and in the launch setup dialog. */
export function promptImprovementActionLabel(
  surface: AssistantPromptImproverTarget["surface"],
): string {
  switch (surface) {
    case "playbook": return "Edit pipeline with agent";
    case "routineBuilder": return "Add Routine with agent";
    case "routineInstructions": return "Improve this Routine";
    case "stewardInstructions": return "Improve Steward defaults";
  }
}

/** Starts an improver Agent for one target. The Agent's accepted change reaches
    the editor through the target's own projection, so this hook reads nothing
    and keeps no timer; a launch failure is returned to the caller. */
export function usePromptImprovement(
  improvement: PromptImprovement | undefined,
  target: AssistantPromptImproverTarget,
) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    start: async () => {
      if (!improvement) return undefined;
      setBusy(true);
      try {
        return await improvement.start({ surface: target.surface, ownerId: target.ownerId });
      } finally {
        setBusy(false);
      }
    },
  };
}

export function PromptImproveButton(props: {
  improvement: PromptImprovement | undefined;
  busy: boolean;
  title: string;
  label?: string;
  start(): void;
  setup(): void;
}) {
  if (!props.improvement) return null;
  return <span className="ap-improve-group agent-action-split">
    <button type="button" className="ap-btn ap-improve agent-action-main" disabled={props.busy} title={props.title} onClick={props.start}>
      <Icon name="sparkles" />{props.label ?? "Improve with agent"}
    </button>
    <button type="button" className="ap-btn ap-improve-setup agent-action-setup" disabled={props.busy} title="Choose the agent and fallback launch settings" onClick={props.setup}>
      Setup <span aria-hidden="true">▾</span>
    </button>
  </span>;
}
