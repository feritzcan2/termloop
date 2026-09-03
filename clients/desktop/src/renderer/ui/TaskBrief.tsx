import { Fragment, type ReactNode } from "react";

export type TaskBriefFormat = "plain" | "jiraWiki";

type TaskBriefBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "code"; text: string };

const JIRA_HEADING = /^h[1-6]\.\s+(.+)$/u;
const JIRA_LIST_ITEM = /^\*+\s+(.+)$/u;
const JIRA_CODE_START = /^\{(?:code(?::[^}]+)?|noformat)\}\s*$/u;
const JIRA_CODE_END = /^\{(?:code|noformat)\}\s*$/u;
const JIRA_INLINE = /\{\{([^{}\n]+)\}\}|\*([^*\n]+)\*/gu;

export function taskBriefBlocks(brief: string, format: TaskBriefFormat): TaskBriefBlock[] {
  if (format === "plain") return [{ kind: "paragraph", lines: brief.split("\n") }];

  const lines = brief.replaceAll("\r\n", "\n").split("\n");
  const blocks: TaskBriefBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.trim().length === 0) {
      index += 1;
      continue;
    }
    const heading = lines[index]!.match(JIRA_HEADING);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
      index += 1;
      continue;
    }
    if (JIRA_CODE_START.test(lines[index]!)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !JIRA_CODE_END.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (JIRA_LIST_ITEM.test(lines[index]!)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(JIRA_LIST_ITEM);
        if (!item) break;
        items.push(item[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length
      && lines[index]!.trim().length > 0
      && !JIRA_HEADING.test(lines[index]!)
      && !JIRA_CODE_START.test(lines[index]!)
      && !JIRA_LIST_ITEM.test(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

function jiraInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const match of value.matchAll(JIRA_INLINE)) {
    const index = match.index;
    if (index > start) nodes.push(value.slice(start, index));
    if (match[1] !== undefined) {
      nodes.push(<code key={`${index}-code`}>{match[1]}</code>);
    } else {
      nodes.push(<strong key={`${index}-strong`}>{match[2]}</strong>);
    }
    start = index + match[0].length;
  }
  if (start < value.length) nodes.push(value.slice(start));
  return nodes;
}

function linesWithBreaks(lines: readonly string[], format: TaskBriefFormat): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${index}-break`} />] : []),
    <Fragment key={`${index}-line`}>
      {format === "jiraWiki" ? jiraInline(line) : line}
    </Fragment>,
  ]);
}

export function TaskBrief(props: { brief: string; format: TaskBriefFormat }) {
  const blocks = taskBriefBlocks(props.brief, props.format);
  return (
    <div className="td-brief">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return <h2 key={index}>{jiraInline(block.text)}</h2>;
          case "paragraph":
            return <p key={index}>{linesWithBreaks(block.lines, props.format)}</p>;
          case "list":
            return <ul key={index}>{block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{jiraInline(item)}</li>
            ))}</ul>;
          case "code":
            return <pre key={index}><code>{block.text}</code></pre>;
        }
      })}
    </div>
  );
}
