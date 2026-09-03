import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskBrief, taskBriefBlocks } from "../src/renderer/ui/TaskBrief.js";

describe("TaskBrief", () => {
  it("renders Jira headings, labels, code spans and lists without exposing wiki markers", () => {
    const brief = [
      "*Environment:* PROD",
      "*Session:* {{cf10c503-3487-f111-b378-953c28394cd4}}",
      "",
      "h2. Summary",
      "",
      "When {{ParkwayAnprSessionImporter}} runs:",
      "",
      "* First pricing attempt fails",
      "* Retry succeeds",
    ].join("\n");

    const markup = renderToStaticMarkup(createElement(TaskBrief, { brief, format: "jiraWiki" }));
    expect(markup).toContain("<strong>Environment:</strong> PROD<br/><strong>Session:</strong>");
    expect(markup).toContain("<code>cf10c503-3487-f111-b378-953c28394cd4</code>");
    expect(markup).toContain("<h2>Summary</h2>");
    expect(markup).toContain("<code>ParkwayAnprSessionImporter</code>");
    expect(markup).toContain("<ul><li>First pricing attempt fails</li><li>Retry succeeds</li></ul>");
    expect(markup).not.toContain("h2. Summary");
    expect(markup).not.toContain("{{");
  });

  it("keeps plain briefs literal and escapes authored markup", () => {
    const brief = "First line\n<script>alert(1)</script>";
    const markup = renderToStaticMarkup(createElement(TaskBrief, { brief, format: "plain" }));
    expect(taskBriefBlocks(brief, "plain")).toEqual([{ kind: "paragraph", lines: brief.split("\n") }]);
    expect(markup).toContain("First line<br/>&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("renders bounded Jira code blocks as inert text", () => {
    const brief = "{code:csharp}\nif (ready) { Run(); }\n{code}";
    const markup = renderToStaticMarkup(createElement(TaskBrief, { brief, format: "jiraWiki" }));
    expect(markup).toContain("<pre><code>if (ready) { Run(); }</code></pre>");
    expect(markup).not.toContain("{code");
  });
});
