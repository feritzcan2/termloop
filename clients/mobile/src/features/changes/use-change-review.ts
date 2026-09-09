import type { SessionDto, TaskDto, TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileRuntime } from "../../application/ports";
import {
  buildReviewMessage, createReviewNote, MAX_REVIEW_MESSAGE_BYTES, MAX_REVIEW_NOTES,
  reviewMessageBytes, taskReviewAgents, updateReviewNotes, type ReviewLine, type ReviewNote,
} from "../../presentation/change-review-notes";
import { submitChangeReview } from "./submit-change-review";

// Owned by the keyed Task screen: drafts survive file changes and refreshed
// observations, but never cross a Task or paired-Mac boundary.
export function useChangeReview(runtime: MobileRuntime, connectionId: string, task: TaskDto, sessions: readonly SessionDto[]) {
  const [notes, setNotes] = useState<readonly ReviewNote[]>([]);
  const [draft, setDraft] = useState<ReviewNote>();
  const [showNotes, setShowNotes] = useState(false);
  const [targetId, setTargetId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const submission = useRef<AbortController | undefined>(undefined);
  const agents = useMemo(() => taskReviewAgents(task, sessions), [task, sessions]);
  const target = agents.find((session) => session.id === targetId) ?? (agents.length === 1 ? agents[0] : undefined);
  const message = useMemo(() => buildReviewMessage(task.title, notes), [task.title, notes]);
  const tooLarge = reviewMessageBytes(message) > MAX_REVIEW_MESSAGE_BYTES;

  useEffect(() => () => submission.current?.abort(), []);

  const edit = (note: ReviewNote) => {
    if (submission.current) return;
    if (!notes.some((value) => value.key === note.key) && notes.length >= MAX_REVIEW_NOTES) {
      setError(`Send or remove feedback before adding more than ${MAX_REVIEW_NOTES} comments.`);
      return;
    }
    setError(undefined);
    setSent(false);
    setDraft(notes.find((value) => value.key === note.key) ?? note);
  };
  const remove = (key: string) => {
    if (submission.current) return;
    setNotes((current) => current.filter((note) => note.key !== key));
    setDraft((current) => current?.key === key ? undefined : current);
  };
  const send = async () => {
    if (submission.current || !target || notes.length === 0 || tooLarge) return;
    const controller = new AbortController();
    submission.current = controller;
    setSending(true);
    setError(undefined);
    setSent(false);
    setDraft(undefined);
    try {
      await submitChangeReview(runtime, connectionId, task.id, target, message, controller.signal);
      if (controller.signal.aborted) return;
      setNotes([]);
      setSent(true);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const detail = cause instanceof Error ? cause.message : "Feedback could not be sent.";
        setError(`${detail} Your comments are kept. If delivery is uncertain, check the agent before retrying.`);
      }
    } finally {
      if (submission.current === controller) submission.current = undefined;
      if (!controller.signal.aborted) setSending(false);
    }
  };

  return {
    notes, draft, showNotes, setShowNotes, agents, target, setTargetId, sending, error, sent, message, tooLarge,
    edit, remove, send,
    openLine: (observationId: string, entry: TaskWorktreeChangeEntryDto, line: ReviewLine) => edit(createReviewNote(observationId, entry, line)),
    updateDraft: (body: string) => {
      if (!draft || submission.current) return;
      setNotes((current) => updateReviewNotes(current, draft, body));
      setDraft({ ...draft, body });
    },
    finishDraft: () => setDraft(undefined),
  };
}

export type ChangeReview = ReturnType<typeof useChangeReview>;
