import { shell, shellOutput } from "./shell";
import { PullRequest } from "./types";

export const checkoutPullRequest = (pr: PullRequest) => {
  const { sha, ref } = pr.head;
  return shell([
    `git fetch origin ${sha}:refs/remotes/origin/${ref}`,
    `git checkout -b ${ref}`,
  ]);
};

export const updatePullRequest = async (pr: PullRequest) => {
  const currentCommit = pr.head.sha;
  const currentBranch = pr.head.ref;
  const baseBranch = pr.base.ref;
  try {
    return await shell([
      `git fetch --unshallow origin ${baseBranch} ${currentBranch}`,
      `git pull --rebase origin ${baseBranch}`,
      `git push --force-with-lease origin ${currentBranch}`,
    ]);
  } catch (e) {
    // If rebase wasn't clean, reset and try regular merge
    console.log("Rebase failed, trying merge instead");
    return shell([
      `git reset --hard ${currentCommit}`,
      `git pull origin ${baseBranch}`,
      `git push origin ${currentBranch}`,
    ]);
  }
};

export const getShortCommit = () =>
  shellOutput("git rev-parse --short HEAD").then((s) => s.toString().trim());
