import { FileIcon, FolderIcon, DefaultFileIcon } from "@react-symbols/icons/utils";
import type { WorkspaceFileEntryDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";

export function WorkspaceFileIcon({ entry }: { entry: Pick<WorkspaceFileEntryDto, "name" | "kind"> }) {
  if (entry.kind === "symlink") return <Icon name="link" />;
  const props = { "aria-hidden": true, focusable: false } as const;
  if (entry.kind === "directory") return <FolderIcon folderName={entry.name.toLowerCase()} {...props} />;
  if (entry.kind !== "file") return <DefaultFileIcon {...props} />;
  return <FileIcon fileName={entry.name} autoAssign {...props} />;
}
