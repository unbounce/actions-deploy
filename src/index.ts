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

// If the PR was deployed to pre-production, then deploy it to production
const handlePrMerged = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>,
  pr: PullRequest
) => {
  const { productionEnvironment, preProductionEnvironment } = config;
  const deployment = await findDeployment(context, preProductionEnvironment);

  if (!deployment) {
    debug(`No deployment found for ${preProductionEnvironment} - quitting`);
    return;
  }

  const deployedPrNumber = deploymentPullRequestNumber(deployment);

  if (deployedPrNumber !== pr.number) {
    debug(
      `${pr.number} was merged, but is not currently deployed to ${preProductionEnvironment} - quitting`
    );
    return;
  }

  if (deployment.sha !== pr.head.sha) {
    const message = [
      `⚠️ The deployment to ${preProductionEnvironment} was outdated, so I skipped deployment to ${productionEnvironment}.`,
      comment.mention(
        `, please check ${comment.code(
          pr.base.ref
        )} and deploy manually if necessary.`
      ),
    ];

    await createComment(context, pr.number, message);
    return;
  }

  debug(
    `${pr.number} was merged, and is currently deployed to ${preProductionEnvironment} - deploying it to ${productionEnvironment}`
  );

  return deployPr(context, pr, productionEnvironment);
};

const deployPr = async (
  context: Context,
  pr: PullRequest,
  environment: string
) => {
  try {
    const { ref } = pr.head;
    await checkoutPullRequest(pr);
    try {
      await updatePullRequest(pr);
    } catch (e) {
      await handleError(
        context,
        pr.number,
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
      { pr: pr.number },
      [
        `export RELEASE_BRANCH=${ref}`,
        config.releaseCommand,
        config.deployCommand,
      ]
    );
    const body = [
      comment.mention(
        `deployed ${version} to ${environment} (${comment.runLink("Details")})`
      ),
      comment.details("Output", comment.codeBlock(output)),
    ];
    await createComment(context, pr.number, body);
  } catch (e) {
    await handleError(
      context,
      pr.number,
      `release and deploy to ${environment} failed`,
      e
    );
  }
};

const handleQA = async (context: Context, pr: PullRequest) => {
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);

  if (environmentIsAvailable(context, deployment)) {
    await deployPr(context, pr, environment);
  } else {
    const prNumber = deploymentPullRequestNumber(deployment);
    const message = `#${prNumber} is currently deployed to ${environment}. It must be merged or closed before this pull request can be deployed.`;
    await createComment(context, pr.number, [comment.mention(message)]);
    error(message);
  }
};

// If the deployed pull request for an environment is not the one contained in
// `context`, set its commit status to pending and notify that its base has
// changed.
const invalidateDeployedPullRequest = async (
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
          `This pull request is no longer up-to-date with ${baseRef} (because #${prNumber} was just merged, which changed ${baseRef}).`,
          `Run ${comment.code(
            "/qa"
          )} to redeploy your changes to ${environment} or ${comment.code(
            "/skip-qa"
          )} if you want to ignore the changes in ${baseRef}.`,
          `Note that using ${comment.code(
            "/skip-qa"
          )} will cause the new changes in ${baseRef} to be excluded when this pull request is merged, and they will not be deployed to ${
            config.productionEnvironment
          }.`,
        ].join(" ");
        await Promise.all([
          setCommitStatus(context, deployedPr.data, "pending"),
          createComment(context, deployedPrNumber, body),
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

const updateOutdatedDeployment = async (
  context: Context<Webhooks.WebhookPayloadPush>
) => {
  const contextBranch = context.payload.ref.replace("refs/heads/", "");
  const { preProductionEnvironment } = config;
  const deployment = await findDeployment(context, preProductionEnvironment);
  let deployedPr;

  if (!deployment) {
    debug(`No deployment found for ${preProductionEnvironment} - quitting`);
    return;
  }

  try {
    const deployedPrNumber = deploymentPullRequestNumber(deployment);

    deployedPr = (
      await context.github.pulls.get(
        context.repo({ pull_number: deployedPrNumber })
      )
    ).data;
  } catch (ex) {
    // move on
  }

  if (!deployedPr) {
    debug(
      `Could not find PR associated with ${preProductionEnvironment} deployment - quitting`
    );
    return;
  }

  const prBranch = deployedPr.head.ref;

  if (prBranch !== contextBranch) {
    debug(
      `Push is unrelated to ${preProductionEnvironment} deployment - nothing to do (${prBranch} vs ${contextBranch})`
    );
    return;
  }

  debug(
    `Re-deploying ${deployedPr.number} to ${preProductionEnvironment} with new commits...`
  );

  return Promise.all([
    setCommitStatus(context, deployedPr, "pending"),
    handleQA(context, deployedPr),
  ]);
};

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of the example workflow in README.md
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on("push", async (context) => {
    await updateOutdatedDeployment(context);
  });

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
          setCommitStatus(context, pr.data, "success"),
          createComment(context, pr.data.number, ["Skipping QA 🤠"]),
        ]);
        break;
      }

      case commandMatches(context, "qa"): {
        await Promise.all([
          setCommitStatus(context, pr.data, "pending"),
          handleQA(context, pr.data),
        ]);
        break;
      }

      default: {
        debug("Unknown command", context);
      }
    }
  });

  app.on("pull_request.closed", async (context) => {
    const pr = await context.github.pulls.get(context.issue());

    // "If the action is closed and the merged key is true, the pull request was merged"
    // https://developer.github.com/v3/activity/events/types/#pullrequestevent
    if (
      context.payload.action === "closed" &&
      context.payload.pull_request.merged
    ) {
      await Promise.all([
        invalidateDeployedPullRequest(context),
        handlePrMerged(context, pr.data),
      ]);
    }
  });
};

adapt(probot);
