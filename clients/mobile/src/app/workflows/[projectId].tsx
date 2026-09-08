import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Banner } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { WorkflowTemplatesScreen } from "@/features/workflows/workflow-templates-screen";

export default function WorkflowsRoute() {
  const params = useLocalSearchParams<{ projectId: string; connectionId?: string }>();
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  // Pin the editor to the Mac that opened it, even if global selection changes.
  const [fallbackConnectionId] = useState(connections.selectedId);
  const connectionId = params.connectionId ?? fallbackConnectionId;
  if (!connectionId) return <Screen><ScreenHeader back="Project" title="Workflow templates" /><Banner kind="warning" message="Choose a connected Mac first." /></Screen>;
  const connection = connections.connections.find((item) => item.id === connectionId);
  const project = overview.byConnection.get(connectionId)?.overview?.projects.find((item) => item.id === params.projectId);
  return <WorkflowTemplatesScreen key={`${connectionId}:${params.projectId}`} port={runtime.workflowTemplates} control={runtime.control} connectionId={connectionId} projectId={params.projectId} projectName={project?.name ?? "Project templates"} online={connection?.availability === "online" && project !== undefined} />;
}
