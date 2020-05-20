import { Application, Context } from "probot";
import adapt from "probot-actions-adapter";
import type Webhooks from "@octokit/webhooks";

import { config } from "./config";
import {
  commandMatches,
  commandParameters,
  createComment,
  setCommitStatus,
  setDeploymentStatus,
  createDeployment,
  findDeployment,
  environmentIsAvailable,
  deploymentPullRequestNumber,
  handleError,
  pullRequestHasBeenDeployed,
  findLastDeploymentForPullRequest,
} from "./utils";
import { debug, error } from "./logging";
import { shell } from "./shell";
import { getShortSha, checkoutPullRequest, updatePullRequest } from "./git";
import * as comment from "./comment";

import { PullRequest } from "./types";

const setup = () => {
  return shell([
    "echo ::group::Setup",
    config.setupCommand,
    "echo ::endgroup::",
  ]);
};

const createDeploymentAndDeploy = async (
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

const runVerify = (version: string, environment: string) => {
  const env = {
    VERSION: version,
    ENVIRONMENT: environment,
  };
  const commands = [
    "echo ::group::Verify",
    config.verifyCommand,
    "echo ::endgroup::",
  ];
  return shell(commands, env);
};

const releaseDeployAndVerify = (
  context: Context,
  version: string,
  environment: string,
  ref: string
) => {
  return createDeploymentAndDeploy(
    context,
    version,
    environment,
    { pr: context.issue().number },
    [
      "echo ::group::Release",
      `export RELEASE_BRANCH=${ref}`,
      config.releaseCommand,
      "echo ::endgroup::",
      "echo ::group::Deploy",
      config.deployCommand,
      "echo ::endgroup::",
      "echo ::group::Verify",
      config.verifyCommand,
      "echo ::endgroup::",
    ]
  );
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
      `️:warning: The deployment to ${preProductionEnvironment} was outdated, so I skipped deployment to ${productionEnvironment}.`,
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

  try {
    const version = await getShortSha(deployment.sha);
    const output = await createDeploymentAndDeploy(
      context,
      version,
      productionEnvironment,
      { pr: pr.number },
      [
        "echo ::group::Deploy",
        config.deployCommand,
        "echo ::endgroup::",
        "echo ::group::Verify",
        config.verifyCommand,
        "echo ::endgroup::",
      ]
    );
    const body = [
      comment.mention(
        `deployed ${version} to ${productionEnvironment} (${comment.runLink(
          "Details"
        )})`
      ),
      comment.logToDetails(output),
    ];

    await createComment(context, pr.number, body);
  } catch (e) {
    await handleError(
      context,
      pr.number,
      `deploy to ${productionEnvironment} failed`,
      e
    );
  }
};

const handleQACommand = async (context: Context, pr: PullRequest) => {
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);

  if (environmentIsAvailable(context, deployment)) {
    try {
      await checkoutPullRequest(pr);
      await setup();
      try {
        await updatePullRequest(pr);
      } catch (e) {
        await handleError(
          context,
          context.issue().number,
          `I failed to bring ${pr.head.ref} up-to-date with ${pr.base.ref}. Please resolve conflicts before running /qa again.`,
          e
        );
        return;
      }
      const version = await getShortSha("HEAD");
      const { ref } = pr.head;
      const output = await releaseDeployAndVerify(
        context,
        version,
        environment,
        ref
      );
      const body = [
        comment.mention(
          `deployed ${version} to ${environment} (${comment.runLink(
            "Details"
          )})`
        ),
        comment.logToDetails(output),
      ];
      await createComment(context, pr.number, body);
    } catch (e) {
      await Promise.all([
        handleError(
          context,
          context.issue().number,
          `release and deploy to ${environment} failed`,
          e
        ),
        setCommitStatus(context, pr, "failure"),
      ]);
    }
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
        `This pull request is currently deployed to ${environment} - nothing to do`
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
      `No pull request currently deployed to ${environment} - nothing to do`
    );
  }
};

// If the deployed pull request for the pre-prod environment is the one contained in
// `context`, it should be replaced with version currently deployed to production.
const resetPreProductionDeployment = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>
) => {
  const { productionEnvironment, preProductionEnvironment } = config;

  if (productionEnvironment === preProductionEnvironment) {
    debug("Production and pre-production environments are the same - quitting");
    return;
  }

  const deployment = await findDeployment(context, preProductionEnvironment);
  const prodDeployment = await findDeployment(context, productionEnvironment);
  const prNumber = context.payload.pull_request.number;
  const deployedPrNumber = deploymentPullRequestNumber(deployment);

  if (deployedPrNumber !== prNumber) {
    debug(
      `PR ${prNumber} is not currently deployed to ${preProductionEnvironment} - nothing to do`
    );
    return;
  }

  if (!prodDeployment) {
    debug(`No ${productionEnvironment} deployment found - quitting`);
    return;
  }

  const version = await getShortSha(prodDeployment.sha);
  const output = await createDeploymentAndDeploy(
    context,
    version,
    preProductionEnvironment,
    { pr: context.issue().number },
    ["echo ::group::Deploy", config.deployCommand, "echo ::endgroup::"]
  );
  const body = [
    `Reset ${preProductionEnvironment} to version ${version} from ${productionEnvironment} (${comment.runLink(
      "Details"
    )}).`,
    comment.logToDetails(output),
  ];

  await createComment(context, prNumber, body);
};

const updateOutdatedDeployment = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>,
  pr: PullRequest
) => {
  const { preProductionEnvironment } = config;
  const deployment = await findDeployment(context, preProductionEnvironment);
  let deployedPrNumber;
  let deployedPr;

  if (!deployment) {
    debug(`No deployment found for ${preProductionEnvironment} - quitting`);
    return;
  }

  try {
    deployedPrNumber = deploymentPullRequestNumber(deployment);

    const prResponse = await context.github.pulls.get(
      context.repo({ pull_number: deployedPrNumber })
    );

    deployedPr = prResponse.data;
  } catch (ex) {
    debug(`Failed to fetch PR data for #${deployedPrNumber}`);
  }

  if (!deployedPr) {
    debug(
      `Could not find PR associated with ${preProductionEnvironment} deployment - quitting`
    );
    return;
  }

  if (deployedPr.number !== pr.number) {
    debug(
      `PR synchronize event is unrelated to ${preProductionEnvironment} deployment - nothing to do (${pr.number} synchronized vs ${deployedPr.number} deployed)`
    );
    return;
  }

  debug(
    `Re-deploying ${deployedPr.number} to ${preProductionEnvironment} with new commits...`
  );

  return Promise.all([
    setCommitStatus(context, deployedPr, "pending"),
    handleQACommand(context, deployedPr),
  ]);
};

const handleVerifyCommand = async (
  context: Context,
  pr: PullRequest,
  providedEnvironment?: string
) => {
  const environment = providedEnvironment || config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);

  if (!deployment) {
    await createComment(context, context.issue().number, [
      `I wasn't able to find a deployment for ${environment}`,
    ]);
    return;
  }

  await checkoutPullRequest(pr);
  await setup();

  try {
    const version = await getShortSha(deployment.sha);
    const output = await runVerify(version, environment);
    const body: string[] = [];

    if (environment === config.preProductionEnvironment) {
      if (deploymentPullRequestNumber(deployment) === pr.number) {
        await setDeploymentStatus(context, deployment.id, "success");
      } else {
        body.push(
          `:warning: This pull request is not currently deployed to ${environment}. You can use ${comment.code(
            "/qa"
          )} to deploy it to ${environment}.`
        );
      }
    }

    await createComment(
      context,
      context.issue().number,
      body.concat([
        comment.mention(
          `verification of ${environment} completed successfully (${comment.runLink(
            "Details"
          )})`
        ),
        comment.logToDetails(output),
      ])
    );
  } catch (e) {
    await handleError(
      context,
      pr.number,
      `verification of ${environment} failed`,
      e
    );
  }
};

const handleDeployCommand = async (
  context: Context,
  pr: PullRequest,
  providedEnvironment?: string,
  providedVersion?: string
) => {
  await checkoutPullRequest(pr);
  await setup();

  const environment = providedEnvironment || config.preProductionEnvironment;
  const deployment = await findLastDeploymentForPullRequest(context, pr.number);

  if (!deployment) {
    await createComment(context, context.issue().number, [
      `I wasn't able to find the latest release for #${pr.number}`,
    ]);
    return;
  }

  const deploymentVersion = await getShortSha(deployment.sha);
  const version = providedVersion || deploymentVersion;

  try {
    const output = await createDeploymentAndDeploy(
      context,
      version,
      environment,
      { pr: pr.number },
      [
        "echo ::group::Deploy",
        config.deployCommand,
        "echo ::endgroup::",
        "echo ::group::Verify",
        config.verifyCommand,
        "echo ::endgroup::",
      ]
    );

    const body = [
      comment.mention(
        `deployed ${version} to ${environment} (${comment.runLink("Details")})`
      ),
      comment.logToDetails(output),
    ];

    await createComment(context, pr.number, body);
  } catch (e) {
    await handleError(context, pr.number, `deploy to ${environment} failed`, e);
  }
};

const commentPullRequestNotDeployed = (context: Context) => {
  return createComment(context, context.issue().number, [
    `This pull request has not been deployed yet. You can use ${comment.code(
      "/qa"
    )} to deploy it to ${config.preProductionEnvironment} or ${comment.code(
      "/skip-qa"
    )} to not deploy this pull request.`,
  ]);
};

const probot = (app: Application) => {
  // Additional app.on events will need to be added to the `on` section of the example workflow in README.md
  // https://help.github.com/en/actions/reference/events-that-trigger-workflows

  app.on("pull_request.synchronize", async (context) => {
    const pr = await context.github.pulls.get(context.issue());
    await updateOutdatedDeployment(context, pr.data);
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
          handleQACommand(context, pr.data),
        ]);
        break;
      }

      case commandMatches(context, "failed-qa"): {
        if (pullRequestHasBeenDeployed(context, pr.data.number)) {
          await setCommitStatus(context, pr.data, "failure");
        } else {
          await commentPullRequestNotDeployed(context);
        }
        break;
      }

      case commandMatches(context, "passed-qa"): {
        if (pullRequestHasBeenDeployed(context, pr.data.number)) {
          await setCommitStatus(context, pr.data, "success");
        } else {
          await commentPullRequestNotDeployed(context);
        }
        break;
      }

      case commandMatches(context, "verify"): {
        const [providedEnvironment] = commandParameters(context);
        await handleVerifyCommand(context, pr.data, providedEnvironment);
        break;
      }

      case commandMatches(context, "deploy"): {
        const [providedEnvironment, providedVersion] = commandParameters(
          context
        );
        await handleDeployCommand(
          context,
          pr.data,
          providedEnvironment,
          providedVersion
        );
        break;
      }

      default: {
        debug("Unknown command", context);
      }
    }
  });

  app.on("pull_request.closed", async (context) => {
    if (context.payload.action !== "closed") {
      return;
    }

    // "If the action is closed and the merged key is true, the pull request was merged"
    // https://developer.github.com/v3/activity/events/types/#pullrequestevent
    if (context.payload.pull_request.merged) {
      const pr = await context.github.pulls.get(context.issue());

      await Promise.all([
        invalidateDeployedPullRequest(context),
        handlePrMerged(context, pr.data),
      ]);
    } else {
      await resetPreProductionDeployment(context);
    }
  });
};

adapt(probot);
