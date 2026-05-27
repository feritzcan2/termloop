import type { Metadata } from "next";
import { buildAlternates } from "../../../../i18n/seo";
import { CodeBlock } from "../../components/code-block";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Dev Servers",
    description:
      "Run per-worktree dev servers, previews, test runners, and setup commands from TermLoop tasks.",
    alternates: buildAlternates(locale, "/docs/dev-servers"),
  };
}

export default function DevServersPage() {
  return (
    <>
      <h1>Dev Servers</h1>
      <p>
        Dev Servers let each task worktree run its own preview, test runner, or
        background command. TermLoop detects localhost URLs and shows them next
        to the matching worktree in the sidebar.
      </p>

      <video
        src="/blog/parallel-agents-devservers.mp4"
        poster="/blog/parallel-agents-devservers-poster.jpg"
        width={1600}
        height={900}
        autoPlay
        loop
        muted
        playsInline
        controls
        className="my-6 rounded-lg w-full h-auto"
      />

      <p>
        The demo shows four agents finishing work in four worktrees, each with
        its own running preview. The config lives at{" "}
        <code>.termloop/devservers.json</code>.
      </p>

      <CodeBlock title=".termloop/devservers.json" lang="json">{`{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "web",
      "name": "Web app",
      "kind": "dev_server",
      "command": "npm run dev -- --host 127.0.0.1",
      "workingDirectory": ".",
      "urlDetection": {
        "autoDetect": true,
        "fallbackUrls": ["http://127.0.0.1:5173"]
      },
      "presentation": {
        "autoOpenFirstUrl": true
      }
    }
  ]
}`}</CodeBlock>

      <h2>Use It</h2>
      <p>
        Open a task, expand Dev Servers in the task sidebar, then start a
        profile. If you do not want to write JSON, use the panel action to have
        an agent generate profiles for the project.
      </p>
    </>
  );
}
