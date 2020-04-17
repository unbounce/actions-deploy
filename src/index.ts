import { Application } from "probot";
import adapt from "probot-actions-adapter";
import { debug } from "./logging";
import { commandMatches, createComment, setCommitStatus } from "./utils";

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of .github/workflows/deployment.yml
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on(["pull_request.opened", "pull_request.reopened"], async (context) => {
    await setCommitStatus(context, "pending");
  });

  app.on(["issue_comment.created"], async (context) => {
    const pr = await context.github.pulls.get(context.issue());

    if (!pr) {
      debug(`No pull request associated with comment ${context.issue()}`);
      return;
    }

    switch (true) {
      case commandMatches(context, "skip-qa"): {
        await Promise.all([
          setCommitStatus(context, "success"),
          createComment(context, "Skipping QA 🤠"),
        ]);
        break;
      }

      default: {
        debug("Unknown command", context);
      }
    }
  });
};

adapt(probot);
