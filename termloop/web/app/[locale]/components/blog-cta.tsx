"use client";

import { usePathname } from "../../../i18n/navigation";
import { DownloadButton } from "./download-button";
import { GitHubButton } from "./github-button";

export function BlogCTA() {
  const pathname = usePathname();
  if (pathname === "/blog") return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 mt-12">
      <DownloadButton />
      <GitHubButton />
    </div>
  );
}
