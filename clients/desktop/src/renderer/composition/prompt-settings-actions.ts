import { desktopApi, type SourceDesktopApi } from "../transport/desktop-api.js";
import { assistantInstructionsEditableSuffix, type PromptAsset } from "../prompt-settings.js";

export function createPromptSettingsActions(projectId: string, sourceApi: SourceDesktopApi) {
  const load = async (): Promise<PromptAsset[]> => {
    const builtIns = await desktopApi.promptAssetsGet();
    if (!projectId) return builtIns;
    const [steward, routines] = await Promise.all([
      sourceApi.stewardConfigurationGet(projectId),
      sourceApi.routineConfigurationList({ projectId }),
    ]);
    const runtime: PromptAsset[] = [];
    const addRuntime = (
      id: string,
      title: string,
      category: string,
      body: string,
      source: NonNullable<PromptAsset["source"]>,
      options: { editable?: boolean; canonicalBody?: string; customized?: boolean; resettable?: boolean } = {},
    ) => runtime.push({
      id,
      title,
      category,
      version: undefined,
      canonicalBody: options.canonicalBody ?? body,
      effectiveBody: body,
      customized: options.customized ?? false,
      source,
      editable: options.editable ?? false,
      resettable: options.resettable ?? false,
    });
    const stewardContext = steward.promptContext;
    addRuntime("runtime.steward.initial", "Steward · Activation message", "Steward", stewardContext.initialPrompt, "project");
    addRuntime("runtime.steward.protected", "Steward · Runtime and safety layer", "Steward", stewardContext.protectedPrompt, "project");
    addRuntime("runtime.steward.instructions", "Steward · Full delivered instructions", "Steward", stewardContext.instructionsPrompt, "project", {
      canonicalBody: stewardContext.protectedPrompt,
      customized: stewardContext.instructionsPrompt.trim() !== stewardContext.protectedPrompt.trim(),
    });
    addRuntime("runtime.steward.wake", "Steward · Wake message", "Steward", stewardContext.wakePrompt, "project");
    for (const routine of routines.configurations) {
      const prefix = `runtime.routine.${routine.id}`;
      addRuntime(`${prefix}.instructions`, `${routine.name} · Instructions`, "Routines", routine.instructions, "routine", { editable: true });
      addRuntime(`${prefix}.context`, `${routine.name} · Next-run memory`, "Routines", routine.contextMarkdown, "routine", { editable: true });
    }
    return [...builtIns, ...runtime];
  };

  const update = async (id: string, body: string): Promise<PromptAsset[]> => {
    const trimmed = body.trim();
    if (id === "runtime.steward.instructions") {
      const current = await sourceApi.stewardConfigurationGet(projectId);
      const suffix = assistantInstructionsEditableSuffix(trimmed, current.promptContext.protectedPrompt);
      if (suffix === undefined) throw new Error("The required Steward runtime beginning must remain unchanged.");
      const configuration = current.configuration;
      const defaults = configuration ?? {
        agentId: "codex" as const,
        model: "gpt-5.6-luna",
        permission: "bypassPermissions" as const,
        reasoning: "medium" as const,
        enabled: false,
      };
      await sourceApi.stewardConfigurationSet({
        projectId,
        agentId: defaults.agentId,
        model: defaults.model,
        permission: defaults.permission,
        reasoning: defaults.reasoning,
        enabled: configuration?.enabled ?? false,
        systemPrompt: suffix,
        expectedRevision: current.stateRevision,
      });
      return load();
    }
    if (id.startsWith("runtime.routine.") && id.endsWith(".instructions")) {
      const routineId = id.slice("runtime.routine.".length, -".instructions".length);
      const current = await sourceApi.routineConfigurationList({ projectId });
      const routine = current.configurations.find((candidate) => candidate.id === routineId);
      if (!routine) throw new Error("Routine is no longer available.");
      await sourceApi.routineConfigurationUpdate({
        routineId: routine.id,
        triggerMode: routine.triggerMode,
        name: routine.name,
        instructions: trimmed,
        whileWaiting: routine.whileWaiting,
        scheduleIntervalSeconds: routine.scheduleIntervalSeconds,
        expectedRevision: current.stateRevision,
        enabled: routine.enabled,
      });
      return load();
    }
    if (id.startsWith("runtime.routine.") && id.endsWith(".context")) {
      const routineId = id.slice("runtime.routine.".length, -".context".length);
      const current = await sourceApi.routineConfigurationList({ projectId });
      const routine = current.configurations.find((candidate) => candidate.id === routineId);
      if (!routine) throw new Error("Routine is no longer available.");
      await sourceApi.routineContextUpdate({
        routineId: routine.id,
        contextMarkdown: body,
        expectedContextRevision: routine.contextRevision,
        expectedRevision: current.stateRevision,
      });
      return load();
    }
    return desktopApi.promptAssetUpdate(id, body);
  };

  const reset = async (id: string): Promise<PromptAsset[]> => {
    if (id.startsWith("runtime.")) throw new Error("Runtime prompts do not have a canonical reset value.");
    return desktopApi.promptAssetReset(id);
  };

  return { load, update, reset };
}
