import { describe, expect, it } from "vitest";
import {
  initialWorktreeDestination,
  localBranchesForTaskBinding,
  selectedWorktreeParent,
  sortLocalBranches,
  suggestedBranchName,
  updateWorktreeDestinationBranch,
  worktreeDestination,
  worktreePathParent,
} from "../src/renderer/ui/worktree-path-suggestion.js";

describe("worktree path suggestions", () => {
  it("places the first worktree beside the selected Project repository", () => {
    expect(initialWorktreeDestination("/Users/ferit/Projects/termloop", "feature-one"))
      .toBe("/Users/ferit/Projects/feature-one_worktree");
  });

  it("updates the branch portion without changing the selected parent", () => {
    expect(updateWorktreeDestinationBranch(
      "/Volumes/code/worktrees/feature-one_worktree",
      "/Volumes/code/worktrees",
      "feature/one",
      "feature/two",
    ))
      .toBe("/Volumes/code/worktrees/feature-two_worktree");
  });

  it("does not overwrite a manually named destination when the branch changes", () => {
    expect(updateWorktreeDestinationBranch(
      "/Volumes/code/worktrees/custom-checkout",
      "/Volumes/code/worktrees",
      "",
      "feature/two",
    )).toBe("/Volumes/code/worktrees/custom-checkout");
  });

  it("reuses the last selected parent without its previous branch", () => {
    const previousPath = "/Volumes/code/worktrees/old-branch_worktree";
    const rememberedParent = selectedWorktreeParent(previousPath, "old-branch");

    expect(rememberedParent).toBe("/Volumes/code/worktrees");
    expect(initialWorktreeDestination("/Users/ferit/Projects/termloop", "new-branch", rememberedParent))
      .toBe("/Volumes/code/worktrees/new-branch_worktree");
  });

  it("preserves Windows separators while flattening the branch into one folder", () => {
    expect(worktreePathParent("C:\\Users\\ferit\\termloop\\"))
      .toBe("C:\\Users\\ferit");
    expect(initialWorktreeDestination("C:\\Users\\ferit\\termloop", "feature/two"))
      .toBe("C:\\Users\\ferit\\feature-two_worktree");
  });

  it("suggests one creatable folder directly under the parent for slashed branches", () => {
    expect(initialWorktreeDestination("/Users/ferit/Projects/termloop", "task/fix-login"))
      .toBe("/Users/ferit/Projects/task-fix-login_worktree");
    expect(selectedWorktreeParent("/Users/ferit/Projects/task-fix-login_worktree", "task/fix-login"))
      .toBe("/Users/ferit/Projects");
  });
});

describe("suggested branch names", () => {
  it("derives a managed branch slug from a plain title", () => {
    expect(suggestedBranchName("Fix login redirect")).toBe("termloop/fix-login-redirect");
    expect(suggestedBranchName("Fix login redirect", "feature")).toBe("feature/fix-login-redirect");
  });

  it("folds diacritics including Turkish dotless i instead of dropping words", () => {
    expect(suggestedBranchName("Görev başlığı ışık")).toBe("termloop/gorev-basligi-isik");
  });

  it("collapses punctuation runs and trims dangling dashes", () => {
    expect(suggestedBranchName("  Fix: the (weird)   bug!! ")).toBe("termloop/fix-the-weird-bug");
  });

  it("yields nothing for an untitled or fully symbolic title", () => {
    expect(suggestedBranchName("")).toBe("");
    expect(suggestedBranchName("!!! ???")).toBe("");
  });

  it("caps the slug without ending on a dash", () => {
    const name = suggestedBranchName("a".repeat(40) + " " + "b".repeat(40));
    expect(name.length).toBeLessThanOrEqual("termloop/".length + 48);
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("local branch ordering", () => {
  it("floats long-lived integration branches above feature branches", () => {
    const branch = (name: string) => ({ name, exact_ref: `refs/heads/${name}` });
    const sorted = sortLocalBranches([branch("alpha"), branch("main"), branch("develop"), branch("zeta")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["main", "develop", "alpha", "zeta"]);
  });

  it("keeps an exact Task branch selectable when the bounded list was truncated", () => {
    const selection = localBranchesForTaskBinding(
      [{ name: "main", exact_ref: "refs/heads/main" }],
      "zzzz/bound-task",
      true,
    );
    expect(selection.requiredBranchMissing).toBe(false);
    expect(selection.branches).toContainEqual({
      name: "zzzz/bound-task",
      exact_ref: "refs/heads/zzzz/bound-task",
    });
  });

  it("reports an absent exact Task branch when the complete list proves it missing", () => {
    expect(localBranchesForTaskBinding(
      [{ name: "main", exact_ref: "refs/heads/main" }],
      "deleted-task-branch",
      false,
    )).toMatchObject({ requiredBranchMissing: true });
  });
});
