// Composition for the stage's Jira browser: one JiraBrowserController per
// PM project, its store bound to the browser's props, and its row actions
// bound to the PM controller (open ticket, add to PM) and the bridge.
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import type { PmJiraIssue } from "@termloop/pm-contract/pm";
import { JiraBrowser, type JiraBrowserActions, type JiraConnection } from "../ui/jira/JiraBrowser.js";
import { JiraBrowserController } from "./jira-browser.js";
import type { PmController } from "./pm-controller.js";

export function JiraStage(props: {
  controller: PmController;
  projectId: string;
  connection: JiraConnection;
  /** The Jira site for "New issue"; absent while unknown. */
  siteUrl: string | undefined;
  /** Where "Add to PM" files new tickets: the active sprint, or the backlog for `null`. */
  sprintId: string | null;
  now: number;
}) {
  const { controller, projectId, connection, siteUrl } = props;
  const sprintId = useRef(props.sprintId);
  sprintId.current = props.sprintId;
  const browser = useMemo(
    () => new JiraBrowserController(controller.bridge, projectId, async (issue: PmJiraIssue) => {
      const ticket = await controller.createTicket(issue.title, sprintId.current, { jiraUrl: issue.url }, false);
      return ticket?.id;
    }),
    [controller, projectId],
  );
  useEffect(() => {
    if (connection === "connected") void browser.start();
  }, [browser, connection]);
  const view = useStore(browser.store);
  const actions = useMemo<JiraBrowserActions>(() => ({
    onPreset: (preset) => void browser.setPreset(preset),
    onProjectKey: (key) => void browser.setProjectKey(key),
    onToggleStatus: (name) => void browser.toggleStatus(name),
    onClearStatuses: () => void browser.clearStatuses(),
    onRunJql: (jql) => void browser.runJql(jql),
    onText: (text) => void browser.setText(text),
    onApplyFilter: (filter) => void browser.applyFilter(filter),
    onSaveFilter: (filter) => browser.saveFilter(filter),
    onDeleteFilter: (id) => browser.deleteFilter(id),
    onRefresh: () => void browser.search(),
    onNewIssue: siteUrl ? () => void controller.bridge.openExternal(newIssueUrl(siteUrl)) : undefined,
    onMode: (mode) => browser.setMode(mode),
    onCurrentSprint: (on) => void browser.setCurrentSprint(on),
    onOpenSettings: () => controller.setView("settings"),
    onCopyKey: (key) => void navigator.clipboard?.writeText(key),
    onOpenTicket: (ticketId) => void controller.selectTicket(ticketId),
    onAddToPm: (issue) => void browser.addToPm(issue),
    onOpenInJira: (url) => void controller.bridge.openExternal(url),
  }), [browser, controller, siteUrl]);
  return <JiraBrowser connection={connection} view={view} now={props.now} actions={actions} />;
}

/** Jira Cloud's create-issue page on the project's site. */
export function newIssueUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/secure/CreateIssue!default.jspa`;
}
