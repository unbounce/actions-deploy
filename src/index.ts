import { Application, Context } from "probot";
import adapt from "probot-actions-adapter";
import type { Octokit } from "@octokit/rest";

const statusCheckContext = "QA";

const setCommitStatus = async (
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

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of .github/workflows/deployment.yml
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on(["pull_request.opened", "pull_request.reopened"], async (context) => {
    await setCommitStatus(context, "pending");
  });
};

adapt(probot);
