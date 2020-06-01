import { shell, shellOutput } from "./shell";
import { PullRequest } from "./types";
import { debug } from "./logging";

export const checkoutPullRequest = (pr: PullRequest) => {
  const { sha, ref } = pr.head;
  return shell([
    `git fetch origin ${sha}:refs/remotes/origin/${ref}`,
    `git checkout ${ref}`,
  ]);
};

export const checkout = (ref: string) =>
  shell(["git fetch origin", `git checkout ${ref}`]);

export const updatePullRequest = async (pr: PullRequest) => {
  const currentBranch = pr.head.ref;
  const baseBranch = pr.base.ref;
  await shell([`git fetch --unshallow origin ${baseBranch} ${currentBranch}`]);
  try {
    return await shell([
      `git rebase origin/${baseBranch}`,
      `git push --force-with-lease origin ${currentBranch}`,
    ]);
  } catch (e) {
    // If rebase wasn't clean, reset and try regular merge
    debug("Rebase failed, trying merge instead");
    return shell([
      `git rebase --abort`,
      `git merge origin/${baseBranch}`,
      `git push origin ${currentBranch}`,
    ]);
  }
};

export const getShortSha = (revision: string) =>
  shellOutput(`git rev-parse --short ${revision}`).then((s) =>
    s.toString().trim()
  );
