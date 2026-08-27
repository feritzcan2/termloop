import { useState } from "react";
import { Icon } from "./Icon.js";

export function ProjectSourceRefreshButton({ sourceName, refresh }: {
  sourceName: string;
  refresh(): Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const label = refreshing ? `Refreshing ${sourceName}` : `Refresh ${sourceName}`;

  const run = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch {
      // The composition callback publishes the actionable connection error.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <button
      type="button"
      className={`project-source-refresh${refreshing ? " refreshing" : ""}`}
      aria-label={label}
      title={label}
      disabled={refreshing}
      onClick={() => { void run(); }}
    >
      <Icon name="restart" />
    </button>
  );
}
