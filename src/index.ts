import { Application, Context } from "probot";
import adapt from "probot-actions-adapter";

import { config } from "./config";
import type Webhooks from "@octokit/webhooks";
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
          await handleError(
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
        await setCommitStatus(context, pr, "success");
      } catch (e) {
        await handleError(
          context,
          `release and deploy to ${environment} failed`,
          e
        );
      }
    } else {
      const prNumber = deploymentPullRequestNumber(deployment);
      const message = `#${prNumber} is currently deployed to ${environment}. It must be merged or closed before this pull request can be deployed.`;
      await createComment(context, [comment.mention(message)]);
      error(message);
    }
  }
};

// If the deployed pull request for an environment is not the one contained in
// `context`, set its commit status to pending and notify that its base has
// changed.
const invalidateDeployedPullRequest = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>
) => {
  // TODO don't hardcode environment
  const environment = "integration";
  const deployment = await findDeployment(context, environment);
  const prNumber = context.payload.pull_request.number;
  const baseRef = context.payload.pull_request.base.ref;
  const deployedPrNumber = deploymentPullRequestNumber(deployment);
  if (typeof deployedPrNumber === "number") {
    if (deployedPrNumber === prNumber) {
      debug(
        "This pull request is currently deployed to ${environment} - nothing to do"
      );
    } else {
      const deployedPr = await context.github.pulls.get(
        context.repo({ pull_number: deployedPrNumber })
      );
      // If bases are the same, invalidate it
      if (baseRef === deployedPr.data.base.ref) {
        debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) has the same base (${baseRef}) - invalidating it`
        );
        const body = [
          `This pull request is no longer up-to-date with ${baseRef} (because #${prNumber} was just merged, which changed ${baseRef}).`,
          `Run ${comment.code(
            "/qa"
          )} to redeploy your changes to ${environment} or ${comment.code(
            "/skip-qa"
          )} if you want to ignore the changes in ${baseRef}.`,
          `Note that using ${comment.code(
            "/skip-qa"
          )} will cause the new changes in ${baseRef} to not be included when this pull request is merged, and its changes deployed to ${
            config.productionEnvironment
          }.`,
        ].join(" ");
        const issueComment = context.repo({
          body,
          issue_number: deployedPrNumber,
        });
        await Promise.all([
          setCommitStatus(context, deployedPr.data, "pending"),
          context.github.issues.createComment(issueComment),
        ]);
      } else {
        debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) has a different base (${deployedPr.data.base.ref} != ${baseRef}) - nothing to do`
        );
      }
    }
  } else {
    debug(
      "No pull request currently deployed to ${environment} - nothing to do"
    );
  }
};

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of the example workflow in README.md
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on(["pull_request.opened", "pull_request.reopened"], async (context) => {
    const pr = await context.github.pulls.get(context.issue());
    await setCommitStatus(context, pr.data, "pending");
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
          setCommitStatus(context.issue(), pr.data, "success"),
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

  app.on("pull_request.closed", async (context) => {
    // "If the action is closed and the merged key is true, the pull request was merged"
    // https://developer.github.com/v3/activity/events/types/#pullrequestevent
    if (
      context.payload.action === "closed" &&
      context.payload.pull_request.merged
    ) {
      await invalidateDeployedPullRequest(context);
    }
  });
};

adapt(probot);
