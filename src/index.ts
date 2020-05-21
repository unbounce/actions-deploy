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
import * as log from "./logging";
import { shell } from "./shell";
import { getShortSha, checkoutPullRequest, updatePullRequest } from "./git";
import {
  Comment,
  mention,
  code,
  runLink,
  logToDetails,
  warning,
  success,
} from "./comment";

import { PullRequest } from "./types";

const setup = () => {
  return shell([
    "echo ::group::Setup",
    config.setupCommand,
    "echo ::endgroup::",
  ]);
};

const createDeploymentAndSetStatus = async (
  context: Context,
  version: string,
  environment: string,
  payload: object,
  f: () => Promise<any>
) => {
  const {
    data: { id },
  } = await createDeployment(context, version, environment, payload);
  try {
    await f();
    await setDeploymentStatus(context, id, "success");
  } catch (e) {
    await setDeploymentStatus(context, id, "error");
    // TODO
    // throw e;
  }
};

const release = async (comment: Comment, version: string) => {
  try {
    await comment.ephemeral(`Releasing ${version}...`);
    const env = {
      VERSION: version,
    };
    const commands = [
      "echo ::group::Release",
      config.releaseCommand,
      "echo ::endgroup::",
    ];
    const output = await shell(commands, env);
    await comment.append(logToDetails(output));
    await comment.append(success(`${version} was successfully released.`));
  } catch (e) {
    await handleError(comment, `releaseing ${version} failed`, e);
    throw e;
  }
};

const deploy = async (
  comment: Comment,
  version: string,
  environment: string
) => {
  try {
    await comment.ephemeral(`Deploying ${version} to ${environment}...`);
    const env = {
      VERSION: version,
      ENVIRONMENT: environment,
    };
    const commands = [
      "echo ::group::Deploy",
      config.deployCommand,
      "echo ::endgroup::",
    ];
    const output = await shell(commands, env);
    await comment.append(logToDetails(output));
    await comment.append(
      success(`${version} was successfully deployed to ${code(environment)}.`)
    );
  } catch (e) {
    await handleError(
      comment,
      `deploying ${version} to ${code(environment)} failed`,
      e
    );
    throw e;
  }
};

const verify = async (
  comment: Comment,
  version: string,
  environment: string
) => {
  try {
    await comment.ephemeral(`Verifying ${version} in ${environment}...`);
    const env = {
      VERSION: version,
      ENVIRONMENT: environment,
    };
    const commands = [
      "echo ::group::Verify",
      config.verifyCommand,
      "echo ::endgroup::",
    ];
    const output = await shell(commands, env);
    await comment.append(logToDetails(output));
    await comment.append(
      success(`${version} was successfully verified in ${code(environment)}.`)
    );
  } catch (e) {
    await handleError(
      comment,
      `verifying ${version} in ${code(environment)} failed`,
      e
    );
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
    log.debug(`No deployment found for ${preProductionEnvironment} - quitting`);
    return;
  }

  const deployedPrNumber = deploymentPullRequestNumber(deployment);

  if (deployedPrNumber !== pr.number) {
    log.debug(
      `${pr.number} was merged, but is not currently deployed to ${preProductionEnvironment} - quitting`
    );
    return;
  }

  if (deployment.sha !== pr.head.sha) {
    const message = [
      warning(
        `️The deployment to ${preProductionEnvironment} was outdated, so I skipped deployment to ${productionEnvironment}.`
      ),
      mention(
        `, please check ${code(pr.base.ref)} and deploy manually if necessary.`
      ),
    ];

    await createComment(context, pr.number, message);
    return;
  }

  log.debug(
    `${pr.number} was merged, and is currently deployed to ${preProductionEnvironment} - deploying it to ${productionEnvironment}`
  );

  const comment = new Comment(
    context,
    context.issue().number,
    runLink("Details")
  );
  const version = await getShortSha(deployment.sha);
  const environment = productionEnvironment;
  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: pr.number },
    async () => {
      await deploy(comment, version, environment);
      await verify(comment, version, environment);
      await comment.append(success(mention("done")));
    }
  );
};

const handleQACommand = async (context: Context, pr: PullRequest) => {
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);

  if (environmentIsAvailable(context, deployment)) {
    await checkoutPullRequest(pr);
    await setup();
    const comment = new Comment(
      context,
      context.issue().number,
      runLink("Details")
    );
    try {
      await updatePullRequest(pr);
    } catch (e) {
      await handleError(
        comment,
        `I failed to bring ${pr.head.ref} up-to-date with ${pr.base.ref}. Please resolve conflicts before running /qa again.`,
        e
      );
      return;
    }
    const version = await getShortSha("HEAD");

    await createDeploymentAndSetStatus(
      context,
      version,
      environment,
      { pr: pr.number },
      async () => {
        try {
          await release(comment, version);
          await deploy(comment, version, environment);
          await verify(comment, version, environment);
          await comment.append(success(mention("done")));
        } catch (e) {
          await setCommitStatus(context, pr, "failure");
          throw e;
        }
      }
    );
  } else {
    const prNumber = deploymentPullRequestNumber(deployment);
    const message = `#${prNumber} is currently deployed to ${environment}. It must be merged or closed before this pull request can be deployed.`;
    await createComment(context, pr.number, [mention(message)]);
    log.error(message);
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
      log.debug(
        `This pull request is currently deployed to ${environment} - nothing to do`
      );
    } else {
      const deployedPr = await context.github.pulls.get(
        context.repo({ pull_number: deployedPrNumber })
      );
      // If bases are the same, invalidate it
      if (baseRef === deployedPr.data.base.ref) {
        log.debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) has the same base (${baseRef}) - invalidating it`
        );
        const body = [
          `This pull request is no longer up-to-date with ${baseRef} (because #${prNumber} was just merged, which changed ${baseRef}).`,
          `Run ${code(
            "/qa"
          )} to redeploy your changes to ${environment} or ${code(
            "/skip-qa"
          )} if you want to ignore the changes in ${baseRef}.`,
          `Note that using ${code(
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
        log.debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) has a different base (${deployedPr.data.base.ref} != ${baseRef}) - nothing to do`
        );
      }
    }
  } else {
    log.debug(
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
    log.debug(
      "Production and pre-production environments are the same - quitting"
    );
    return;
  }

  const deployment = await findDeployment(context, preProductionEnvironment);
  const prodDeployment = await findDeployment(context, productionEnvironment);
  const prNumber = context.payload.pull_request.number;
  const deployedPrNumber = deploymentPullRequestNumber(deployment);

  if (deployedPrNumber !== prNumber) {
    log.debug(
      `PR ${prNumber} is not currently deployed to ${preProductionEnvironment} - nothing to do`
    );
    return;
  }

  if (!prodDeployment) {
    log.debug(`No ${productionEnvironment} deployment found - quitting`);
    return;
  }

  const comment = new Comment(
    context,
    context.issue().number,
    runLink("Details")
  );
  const version = await getShortSha(prodDeployment.sha);
  const environment = preProductionEnvironment;

  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: context.issue().number },
    async () => {
      await deploy(comment, version, environment);
      await verify(comment, version, environment);
      await comment.append(success(mention("done")));
    }
  );

  await comment.append(
    success(
      `Reset ${preProductionEnvironment} to version ${version} from ${productionEnvironment}.`
    )
  );
};

// const resetProductionDeployment = async (
//   context: Context<Webhooks.WebhookPayloadPullRequest>
// ) => {
//   findPreviousDeployment
// }

const updateOutdatedDeployment = async (
  context: Context<Webhooks.WebhookPayloadPullRequest>,
  pr: PullRequest
) => {
  const { preProductionEnvironment } = config;
  const deployment = await findDeployment(context, preProductionEnvironment);
  let deployedPrNumber;
  let deployedPr;

  if (!deployment) {
    log.debug(`No deployment found for ${preProductionEnvironment} - quitting`);
    return;
  }

  try {
    deployedPrNumber = deploymentPullRequestNumber(deployment);

    const prResponse = await context.github.pulls.get(
      context.repo({ pull_number: deployedPrNumber })
    );

    deployedPr = prResponse.data;
  } catch (ex) {
    log.debug(`Failed to fetch PR data for #${deployedPrNumber}`);
  }

  if (!deployedPr) {
    log.debug(
      `Could not find PR associated with ${preProductionEnvironment} deployment - quitting`
    );
    return;
  }

  if (deployedPr.number !== pr.number) {
    log.debug(
      `PR synchronize event is unrelated to ${preProductionEnvironment} deployment - nothing to do (${pr.number} synchronized vs ${deployedPr.number} deployed)`
    );
    return;
  }

  log.debug(
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

  const comment = new Comment(
    context,
    context.issue().number,
    runLink("Details")
  );

  try {
    const version = await getShortSha(deployment.sha);
    await verify(comment, version, environment);

    if (environment === config.preProductionEnvironment) {
      if (deploymentPullRequestNumber(deployment) === pr.number) {
        await setDeploymentStatus(context, deployment.id, "success");
      } else {
        await comment.append(
          warning(
            `This pull request is not currently deployed to ${environment}. You can use ${code(
              "/qa"
            )} to deploy it to ${environment}.`
          )
        );
      }
    }

    await comment.append(success(mention("done")));
  } catch (e) {
    await handleError(comment, `verification of ${environment} failed`, e);
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
  const comment = new Comment(
    context,
    context.issue().number,
    runLink("Details")
  );

  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: pr.number },
    async () => {
      await release(comment, version);
      await deploy(comment, version, environment);
      await verify(comment, version, environment);
      await comment.append(success(mention("done")));
    }
  );
};

const commentPullRequestNotDeployed = (context: Context) => {
  return createComment(context, context.issue().number, [
    `This pull request has not been deployed yet. You can use ${code(
      "/qa"
    )} to deploy it to ${config.preProductionEnvironment} or ${code(
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

  app.on(["issue_created", "pull_request.opened"], async (context) => {
    const pr = await context.github.pulls.get(context.issue());

    if (!pr) {
      log.debug(`No pull request associated with comment ${context.issue()}`);
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
        log.debug("Unknown command", context);
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
