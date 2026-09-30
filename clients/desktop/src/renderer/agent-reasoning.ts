import type { AgentCapabilityDto } from "@termloop/contract/current";

export function agentReasoningOptions(capability: AgentCapabilityDto | undefined, model: string): AgentCapabilityDto["reasoning"] {
  return capability?.model_reasoning?.find((entry) => entry.model === model)?.reasoning
    ?? capability?.reasoning ?? ["default"];
}
