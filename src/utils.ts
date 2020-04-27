import type { Octokit } from "@octokit/rest";
import { Context } from "probot";

const statusCheckContext = "QA";

// From https://github.com/probot/commands/blob/master/index.js
export const commandMatches = (context: Context, match: string): boolean => {
  const { comment, issue, pull_request: pr } = context.payload;
  const command = (comment || issue || pr).body.match(/^\/([\w-]+)\s*?(.*)?$/m);
  return command && command[1] === match;
};

export const createComment = (context: Context, body: string[]) => {
  const issueComment = context.issue({ body: body.join("\n") });
  return context.github.issues.createComment(issueComment);
};

export const setCommitStatus = async (
  context: Context,
  state: Octokit["ReposCreateStatusParams"]["state"]
) => {
  const pr = await context.github.pulls.get(context.issue());
  const { sha } = pr.data.head;
  if (pr) {
    return context.github.repos.createStatus(
      context.repo({
        sha,
        state,
        context: statusCheckContext,
      })
    );
  } else {
    return Promise.resolve();
  }
};
