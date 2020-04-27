import { Application, Context } from "probot";
import adapt from "probot-actions-adapter";

import { config } from "./config";
import {
  commandMatches,
  createComment,
  setCommitStatus,
  setDeploymentStatus,
  createDeployment,
  findDeployment,
  environmentIsAvailable,
  deploymentPullRequestNumber,
  handleError,
} from "./utils";
import { debug, error } from "./logging";
import { shell } from "./shell";
import { getShortCommit, checkoutPullRequest, updatePullRequest } from "./git";
import * as comment from "./comment";

import { PullRequest } from "./types";

const handleDeploy = async (
  context: Context,
  version: string,
  environment: string,
  payload: object,
  commands: string[]
) => {
  // Resources created as part of an Action can not trigger other actions, so we
  // can't handle the deployment as part of `app.on('deployment')`
  const {
    data: { id },
  } = await createDeployment(context, version, environment, payload);
  try {
    const env = {
      VERSION: version,
      ENVIRONMENT: environment,
    };
    const output = await shell(commands, env);
    await setDeploymentStatus(context, id, "success");
    return output;
  } catch (e) {
    await setDeploymentStatus(context, id, "error");
    throw e;
  }
};

const handleQA = async (context: Context, pr: PullRequest) => {
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);
  if (commandMatches(context, "qa")) {
    if (environmentIsAvailable(context, deployment)) {
      try {
        const { ref } = pr.head;
        await checkoutPullRequest(pr);
        try {
          await updatePullRequest(pr);
        } catch (e) {
          handleError(
            context,
            `I failed to bring ${pr.head.ref} up-to-date with ${pr.base.ref}. Please resolve conflicts before running /qa again.`,
            e
          );
          return;
        }
        const version = await getShortCommit();
        const output = await handleDeploy(
          context,
          version,
          environment,
          { pr: context.issue().number },
          [
            `export RELEASE_BRANCH=${ref}`,
            config.releaseCommand,
            config.deployCommand,
          ]
        );
        const body = [
          comment.mention(
            `deployed ${version} to ${environment} (${comment.runLink(
              "Details"
            )})`
          ),
          comment.details("Output", comment.codeBlock(output)),
        ];
        await createComment(context, body);
      } catch (e) {
        handleError(context, `release and deploy to ${environment} failed`, e);
      }
    } else {
      const prNumber = deploymentPullRequestNumber(deployment);
      const message = `#${prNumber} is currently deployed to ${environment}. It must be merged or closed before this pull request can be deployed.`;
      await createComment(context, [comment.mention(message)]);
      error(message);
    }
  }
};

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of the example workflow in README.md
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on(["pull_request.opened", "pull_request.reopened"], async (context) => {
    await setCommitStatus(context, "pending");
  });

  app.on(["issue_comment.created", "pull_request.opened"], async (context) => {
    const pr = await context.github.pulls.get(context.issue());

    if (!pr) {
      debug(`No pull request associated with comment ${context.issue()}`);
      return;
    }

    switch (true) {
      case commandMatches(context, "skip-qa"): {
        await Promise.all([
          setCommitStatus(context, "success"),
          createComment(context, ["Skipping QA 🤠"]),
        ]);
        break;
      }

      case commandMatches(context, "qa"): {
        await handleQA(context, pr.data);
        break;
      }

      default: {
        debug("Unknown command", context);
      }
    }
  });
};

adapt(probot);
