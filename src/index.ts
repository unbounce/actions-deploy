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
            `I failed to bring ${comment.code(
              pr.head.ref
            )} up-to-date with ${comment.code(
              pr.base.ref
            )}. Please resolve conflicts before running ${comment.code(
              "/qa"
            )} again.`,
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
const invalidateDeploymentAfterPullRequestMerged = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>
) => {
  const environment = config.preProductionEnvironment;
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
          `This pull request is no longer up-to-date with ${comment.code(
            baseRef
          )} (because #${prNumber} was just merged, which changed ${comment.code(
            baseRef
          )}).`,
          `Run ${comment.code(
            "/qa"
          )} to redeploy your changes to ${environment} or ${comment.code(
            "/skip-qa"
          )} if you want to ignore the changes in ${comment.code(baseRef)}.`,
          `Note that using ${comment.code(
            "/skip-qa"
          )} will cause the new changes in ${comment.code(
            baseRef
          )} to be excluded when this pull request is merged, and they will not be deployed to ${
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

// If the base for the deployed pull request matches is master set its commit
// status to pending and notify that its base has changed.
const invalidateDeploymentAfterMasterPushed = async (
  context: Context<Webhooks.WebhookPayloadPush>
) => {
  const pushedRef = "master";
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);
  const deployedPrNumber = deploymentPullRequestNumber(deployment);
  if (typeof deployedPrNumber === "number") {
    const deployedPr = await context.github.pulls.get(
      context.repo({ pull_number: deployedPrNumber })
    );
    if (deployedPr.data.base.ref === pushedRef) {
      if (deployedPr.data.merged) {
        debug(
          `Pull request deployed to ${environment} (#${deployedPr.data.number}) is merged - nothing to do`,
          context
        );
      } else {
        // Invalidate
        const body = [
          `This pull request is no longer up-to-date with ${comment.code(
            pushedRef
          )} (because changes were pushed directly to ${comment.code(
            pushedRef
          )}).`,
          `Run ${comment.code(
            "/qa"
          )} to redeploy your changes to ${environment} or ${comment.code(
            "/skip-qa"
          )} if you want to ignore the changes in ${comment.code(pushedRef)}.`,
          `Note that using ${comment.code(
            "/skip-qa"
          )} will cause the new changes in ${comment.code(
            pushedRef
          )} to be excluded when this pull request is merged, and they will not be deployed to ${
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
      }
    } else {
      debug(
        `Pull request deployed to ${environment} (#${deployedPr.data.number}) has a different base (${deployedPr.data.base.ref} != master) - nothing to do`,
        context
      );
    }
  } else {
    debug(
      `No pull request deployed to ${environment} - nothing to do`,
      context
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
      await invalidateDeploymentAfterPullRequestMerged(context);
    } else {
      debug(
        `Closed pull request was not merged (action: ${context.payload.action}, merged: ${context.payload.pull_request.merged})`
      );
    }
  });

  app.on("push", async (context) => {
    if (context.payload.ref === "refs/heads/master") {
      const prs = await context.github.repos.listPullRequestsAssociatedWithCommit(
        context.repo({ commit_sha: context.payload.after })
      );
      if (prs.data.every((pr) => !pr.merged_at)) {
        await invalidateDeploymentAfterMasterPushed(context);
      } else {
        debug(
          `Push ref was part of a merged pull request: ${context.payload.ref}`
        );
      }
    } else {
      debug(`Push ref was not for master: ${context.payload.ref}`);
    }
  });
};

adapt(probot);
