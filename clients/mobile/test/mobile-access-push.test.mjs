import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  apnsPayload,
  attentionTransitions,
  createApnsJwt,
  createApnsRequestId,
  defaultPushNotificationPreferences,
  macDesktopRecentlyActive,
  nextStatusMap,
  pendingStewardDecisionNotifications,
  pushDeliveryOptions,
  pushNotificationPreferencesOf,
  retainCurrentAttention,
  stewardMessageNotificationOf,
  stewardTranscriptNotifications,
  upsertPushDevice,
  withNotificationPreview,
} from "../scripts/mobile-access-push.mjs";

const session = {
  id: "ses_claude",
  project_id: "prj_1",
  name: "Mobile notifications",
  kind: "Agent",
  lifecycle_state: "running",
  runtime_epoch: 17,
  process: { agent_id: "claude", template_ref: null },
};

describe("mobile APNs attention projection", () => {
  it("emits only new input and structured review transitions", () => {
    const previous = new Map([[session.id, "working"]]);
    const review = attentionTransitions(previous, [status("idle", "hook")], [session]);
    expect(review).toEqual([expect.objectContaining({
      kind: "needsReview", sessionId: session.id, runtimeEpoch: 17,
      title: "Claude is ready for review",
    })]);
    const waiting = attentionTransitions(previous, [status("awaitingInput", "hook")], [session]);
    expect(waiting[0]).toMatchObject({ kind: "needsInput", title: "Claude needs your input" });
    expect(attentionTransitions(new Map([[session.id, "awaitingInput"]]), [status("awaitingInput", "hook")], [session]))
      .toEqual([]);
    expect(attentionTransitions(previous, [status("idle", "polling")], [session])).toEqual([]);
    expect(nextStatusMap([status("idle", "hook")]).get(session.id)).toBe("idle");
  });

  it("uses available agent content and never falls back to tap-to-review copy", () => {
    const [notification] = attentionTransitions(
      new Map([[session.id, "working"]]),
      [status("idle", "hook")],
      [{ ...session, name: null }],
    );
    expect(notification.body).toBe("Turn completed.");
    expect(notification.body).not.toMatch(/tap to/iu);
    expect(withNotificationPreview(notification, "I finished the reconnect fix.").body)
      .toBe("I finished the reconnect fix.");
    expect(withNotificationPreview(notification, undefined)).toBe(notification);
  });

  it("never notifies for Steward or Worker Sessions across Projects", () => {
    const silentSessions = [
      { template_ref: "builtin.steward.executor", name: "Project Steward" },
      { template_ref: "builtin.worker.executor", name: "Routine Runner" },
      { template_ref: "builtin.steward.task-assignment", name: "Assigned work" },
      { template_ref: "builtin.worker.future-lane", name: "Future Worker" },
      { template_ref: "builtin.assistant.activation", name: "Custom assistant name" },
      { template_ref: null, name: "Project Steward" },
      { template_ref: null, name: "Worker 12" },
    ];
    for (const [index, candidate] of silentSessions.entries()) {
      const assistant = {
        ...session,
        id: `ses_silent_${index}`,
        project_id: `prj_${index % 2}`,
        name: candidate.name,
        process: { ...session.process, template_ref: candidate.template_ref },
      };
      expect(attentionTransitions(
        new Map([[assistant.id, "working"]]),
        [{ ...status("awaitingInput", "hook"), sessionId: assistant.id }],
        [assistant],
      )).toEqual([]);
      expect(attentionTransitions(
        new Map([[assistant.id, "working"]]),
        [{ ...status("idle", "hook"), sessionId: assistant.id }],
        [assistant],
      )).toEqual([]);
    }
  });

  it("still notifies an ordinary Agent even when its user-authored name resembles a Worker", () => {
    const ordinary = {
      ...session,
      name: "Worker 1",
      process: { ...session.process, template_ref: "builtin.agent.interactive" },
    };
    expect(attentionTransitions(
      new Map([[ordinary.id, "working"]]),
      [status("idle", "appServer")],
      [ordinary],
    )).toEqual([expect.objectContaining({ kind: "needsReview", sessionId: ordinary.id })]);
  });

  it("defers current attention while the Mac is active and cancels resolved work", () => {
    const notification = attentionTransitions(
      new Map([[session.id, "working"]]),
      [status("awaitingInput", "hook")],
      [session],
    )[0];
    const pending = new Map([[session.id, notification]]);

    expect(retainCurrentAttention(pending, [status("awaitingInput", "hook")]).size).toBe(1);
    expect(retainCurrentAttention(pending, [status("working", "hook")]).size).toBe(0);
    expect(macDesktopRecentlyActive('"HIDIdleTime" = 119000000000')).toBe(true);
    expect(macDesktopRecentlyActive('"HIDIdleTime" = 120000000000')).toBe(false);
    expect(macDesktopRecentlyActive("unsupported host output")).toBe(false);
  });

  it("keeps a bounded multi-device registry and a session deep link without terminal content", () => {
    let registry = { version: 1, devices: [] };
    for (let index = 0; index < 10; index += 1) {
      registry = upsertPushDevice(registry, {
        deviceToken: index.toString(16).padStart(64, "a"),
        environment: "production",
        bundleId: "ai.termloop.next.mobile.dev",
      }, index);
    }
    expect(registry.devices).toHaveLength(8);
    const payload = apnsPayload({
      kind: "needsInput",
      sessionId: session.id,
      projectId: session.project_id,
      title: "Claude needs your input",
      body: "Mobile notifications",
    }, "mac_1");
    expect(payload).toMatchObject({ connectionId: "mac_1", sessionId: session.id, projectId: "prj_1" });
    expect(JSON.stringify(payload)).not.toContain("terminal");
  });

  it("applies independent Mobile and Watch delivery preferences", () => {
    const preferences = pushNotificationPreferencesOf({
      version: 1,
      mobile: {
        ...defaultPushNotificationPreferences.mobile,
        agentReadyForReview: false,
      },
      watch: {
        ...defaultPushNotificationPreferences.watch,
        stewardMessages: false,
        playSound: false,
      },
    });
    expect(preferences).toBeDefined();
    expect(pushDeliveryOptions(preferences, "ai.termloop.mobile", "needsInput"))
      .toEqual({ enabled: true, playSound: true });
    expect(pushDeliveryOptions(preferences, "ai.termloop.mobile", "needsInput", { macActive: true }))
      .toEqual({ enabled: false, playSound: true });
    expect(pushDeliveryOptions(preferences, "ai.termloop.mobile", "needsReview"))
      .toEqual({ enabled: false, playSound: true });
    expect(pushDeliveryOptions(preferences, "ai.termloop.mobile.watch", "stewardProposal"))
      .toEqual({ enabled: false, playSound: false });

    const activeWatch = pushNotificationPreferencesOf({
      ...preferences,
      watch: { ...preferences.watch, notifyWhenMacActive: true, stewardMessages: true },
    });
    expect(pushDeliveryOptions(activeWatch, "ai.termloop.mobile.watch", "stewardProposal", { macActive: true }))
      .toEqual({ enabled: true, playSound: false });

    const silent = apnsPayload({
      kind: "needsInput",
      sessionId: session.id,
      projectId: session.project_id,
      title: "Claude needs your input",
      body: "Waiting",
    }, "mac_1", { playSound: false });
    expect(silent.aps).not.toHaveProperty("sound");
    expect(pushNotificationPreferencesOf({ version: 1, mobile: {}, watch: {} })).toBeUndefined();
  });

  it("uses typed Watch actions for Steward proposals and suggestions", () => {
    const project = { id: "prj_1", name: "Nucleus" };
    const proposal = stewardMessageNotificationOf(project, {
      id: "proposal-1", sequence: 7, author: "steward", kind: "proposal",
      content: "Open the master PR?",
    });
    expect(apnsPayload(proposal, "mac_1")).toMatchObject({
      aps: {
        category: "TERMLOOP_STEW_PROPOSAL",
        "interruption-level": "active",
        "relevance-score": 1,
        "thread-id": "steward-decision-prj_1",
      },
      chatProjectId: "prj_1",
      stewardMessageId: "proposal-1",
      stewardMessageKind: "proposal",
    });
    const suggestion = stewardMessageNotificationOf(project, {
      id: "suggestion-1", sequence: 8, author: "steward", kind: "suggestion",
      content: "I can tighten the Routine instructions.",
    });
    expect(apnsPayload(suggestion, "mac_1").aps.category).toBe("TERMLOOP_STEW_SUGGESTION");
    expect(proposal.title).toBe("Onayın gerekiyor · Nucleus");
    expect(suggestion.title).toBe("Öneri hazır · Nucleus");
  });

  it("baselines transcript history then notifies every new Steward message once", () => {
    const projects = [{ id: "prj_1", name: "Nucleus" }];
    const baseline = stewardTranscriptNotifications(new Map(), projects, new Map([
      ["prj_1", [{ id: "old", sequence: 4, author: "steward", kind: "reply", content: "Old" }]],
    ]));
    expect(baseline.notifications).toEqual([]);
    expect(baseline.nextSequences.get("prj_1")).toBe(4);

    const changed = stewardTranscriptNotifications(baseline.nextSequences, projects, new Map([
      ["prj_1", [
        { id: "proposal", sequence: 6, author: "steward", kind: "proposal", content: "Approve?" },
        { id: "user", sequence: 5, author: "user", kind: "reply", content: "Check it" },
      ]],
    ]));
    expect(changed.notifications).toEqual([
      expect.objectContaining({ kind: "stewardProposal", stewardMessageId: "proposal" }),
    ]);
    expect(changed.nextSequences.get("prj_1")).toBe(6);
    expect(stewardTranscriptNotifications(changed.nextSequences, projects, new Map([
      ["prj_1", [{ id: "proposal", sequence: 6, author: "steward", kind: "proposal", content: "Approve?" }]],
    ])).notifications).toEqual([]);
  });

  it("redelivers only a still-pending decision when the gateway starts", () => {
    const projects = [{ id: "prj_1", name: "Nucleus" }];
    const pending = stewardTranscriptNotifications(new Map(), projects, new Map([
      ["prj_1", [
        { id: "user", sequence: 3, author: "user", kind: "reply", content: "Check it" },
        { id: "proposal", sequence: 4, author: "steward", kind: "proposal", content: "Approve?" },
      ]],
    ]));
    expect(pending.notifications).toEqual([
      expect.objectContaining({ kind: "stewardProposal", stewardMessageId: "proposal" }),
    ]);

    const answered = stewardTranscriptNotifications(new Map(), projects, new Map([
      ["prj_1", [
        { id: "proposal", sequence: 4, author: "steward", kind: "proposal", content: "Approve?" },
        { id: "approval", sequence: 5, author: "user", kind: "approval", content: "Approved" },
      ]],
    ]));
    expect(answered.notifications).toEqual([]);
  });

  it("keeps a decision pending across later Steward updates but clears it after user input", () => {
    const projects = [{ id: "prj_1", name: "Nucleus" }];
    const pendingMessages = new Map([["prj_1", [
      { id: "proposal", sequence: 4, author: "steward", kind: "proposal", content: "Approve?" },
      { id: "update", sequence: 5, author: "steward", kind: "update", content: "Still working" },
    ]]]);
    expect(pendingStewardDecisionNotifications(projects, pendingMessages)).toEqual([
      expect.objectContaining({ stewardMessageId: "proposal", kind: "stewardProposal" }),
    ]);
    expect(stewardTranscriptNotifications(new Map(), projects, pendingMessages).notifications).toEqual([
      expect.objectContaining({ stewardMessageId: "proposal", kind: "stewardProposal" }),
    ]);

    const answeredMessages = new Map([["prj_1", [
      ...pendingMessages.get("prj_1"),
      { id: "answer", sequence: 6, author: "user", kind: "approval", content: "Approved" },
    ]]]);
    expect(pendingStewardDecisionNotifications(projects, answeredMessages)).toEqual([]);
  });

  it("creates an ES256 APNs provider token with bounded claims", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = createApnsJwt({ teamId: "TEAM1234", keyId: "KEY12345", privateKey }, 1234);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY12345" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "TEAM1234", iat: 1234 });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });

  it("uses APNs' canonical UUID message identifier", () => {
    expect(createApnsRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

function status(value, source) {
  return { sessionId: session.id, status: value, source, observedAtEpochMs: 1 };
}
