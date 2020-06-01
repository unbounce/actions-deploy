import { Application, Context } from "probot";
import adapt from "probot-actions-adapter";
import type Webhooks from "@octokit/webhooks";

import { config } from "./config";
import {
  commandMatches,
  commandParameters,
  commentBody,
  componentLabel,
  createDeployment,
  deploymentPullRequestNumber,
  environmentIsAvailable,
  findDeployment,
  findLastDeploymentForPullRequest,
  findPreviousDeployment,
  findFirstDeploymentForRelease,
  getDeploymentStatus,
  handleError,
  looksLikeACommand,
  maybeComponentName,
  pullRequestHasBeenDeployed,
  reactToComment,
  setCommitStatus,
  setDeploymentStatus,
} from "./utils";
import * as log from "./logging";
import { shell } from "./shell";
import {
  getShortSha,
  checkout,
  checkoutPullRequest,
  updatePullRequest,
} from "./git";
import {
  Comment,
  code,
  error,
  info,
  logToDetails,
  link,
  mention,
  success,
  warning,
} from "./comment";

import { Deployment, PullRequest } from "./types";

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
    // The error is not re-thrown here - it is handled within `f` and is only
    // raised to this level so that the deployment can be marked as "error"
  }
};

const setup = async (comment: Comment) => {
  try {
    await shell([
      "echo ::group::Setup",
      config.setupCommand,
      "echo ::endgroup::",
    ]);
  } catch (e) {
    await handleError(comment, `setup failed`, e);
    throw e;
  }
};

const release = async (comment: Comment, version: string) => {
  try {
    comment.separator();
    await comment.append(`Releasing ${maybeComponentName()}${version}...`);
    const env = {
      VERSION: version,
    };
    const commands = [
      "echo ::group::Release",
      config.releaseCommand,
      "echo ::endgroup::",
    ];
    const output = await shell(commands, env);
    await comment.append([
      logToDetails(output),
      success(`${maybeComponentName()}${version} was successfully released.`),
    ]);
  } catch (e) {
    await handleError(
      comment,
      `releaseing ${maybeComponentName()}${version} failed`,
      e
    );
    throw e;
  }
};

const deploy = async (
  comment: Comment,
  version: string,
  environment: string
) => {
  try {
    comment.separator();
    await comment.append(
      `Deploying ${maybeComponentName()}${version} to ${code(environment)}...`
    );
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
    await comment.append([
      logToDetails(output),
      success(
        `${maybeComponentName()}${version} was successfully deployed to ${code(
          environment
        )}.`
      ),
    ]);
  } catch (e) {
    await handleError(
      comment,
      `deploying ${maybeComponentName()}${version} to ${code(
        environment
      )} failed`,
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
    comment.separator();
    await comment.append(
      `Verifying ${maybeComponentName()}${version} in ${code(environment)}...`
    );
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
    await comment.append([
      logToDetails(output),
      success(
        `${maybeComponentName()}${version} was successfully verified in ${code(
          environment
        )}.`
      ),
    ]);
  } catch (e) {
    await handleError(
      comment,
      `verifying ${maybeComponentName()}${version} in ${code(
        environment
      )} failed`,
      e
    );
    throw e;
  }
};

const rollback = async (
  context: Context,
  comment: Comment,
  pr: PullRequest,
  previousDeployment: Deployment
) => {
  const environment = config.productionEnvironment;
  const previousVersion = previousDeployment.ref;
  const previousPrNumber = deploymentPullRequestNumber(previousDeployment);

  await comment.append(
    warning(
      `Rolling back ${maybeComponentName()}${code(
        environment
      )} to ${previousVersion}...`
    )
  );

  // Switch to the commit the previous release before deploying.
  //
  // NOTE That this isn't guaranteed to be the commit that was used to
  // deploy this version to production (as /deploy <environment> <version>
  // could have been used on a commit that was not `previousVersion`), but
  // this is likely to be correct in most cases, and is definitely more
  // correct that using the current commit to deploy `previousVersion`.
  try {
    await checkout(previousVersion);
  } catch (e) {
    await handleError(
      comment,
      "failed to checkout to previous deployed version",
      e
    );
  }

  if (previousPrNumber) {
    const previousPrMessage = `Deploy ${maybeComponentName()}${previousVersion} to ${code(
      environment
    )} triggered via #${pr.number} due to ${link("rollback", comment.url)}.`;
    await Comment.create(context, previousPrNumber, previousPrMessage);
  }

  await createDeploymentAndSetStatus(
    context,
    previousVersion,
    environment,
    { pr: deploymentPullRequestNumber(previousDeployment) },
    async () => {
      await deploy(comment, previousVersion, environment);
      await verify(comment, previousVersion, environment);
    }
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

  log.debug(
    `${pr.number} was merged, and is currently deployed to ${preProductionEnvironment} - deploying it to ${productionEnvironment}`
  );

  const comment = new Comment(context, context.issue().number);

  const deploymentStatus = await getDeploymentStatus(context, deployment.id);
  if (deploymentStatus !== "success") {
    await comment.append(
      error(
        mention(
          `The ${maybeComponentName()}${code(
            preProductionEnvironment
          )} deployment resulted in ${code(
            deploymentStatus || "unknown"
          )} - not deploying to ${code(productionEnvironment)}.`
        )
      )
    );
    return;
  }

  await comment.append(
    mention(`Deploying to ${code(productionEnvironment)}...`)
  );

  await setup(comment);
  const version = deployment.ref;
  const environment = productionEnvironment;
  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: pr.number },
    async () => {
      try {
        await deploy(comment, version, environment);
        await verify(comment, version, environment);
      } catch (e) {
        const previousDeployment = await findPreviousDeployment(
          context,
          environment
        );
        if (previousDeployment) {
          await rollback(context, comment, pr, previousDeployment);
        } else {
          await comment.append(
            warning(
              `Unable to find previous deployment for ${maybeComponentName()}${code(
                environment
              )} to roll back to.`
            )
          );
        }

        // Re-throw so that first deployment is marked as "error"
        throw e;
      }
      await comment.append(success("Done"));
    }
  );
};

const handleQACommand = async (context: Context, pr: PullRequest) => {
  const environment = config.preProductionEnvironment;
  const deployment = await findDeployment(context, environment);

  if (await environmentIsAvailable(context, deployment)) {
    await checkoutPullRequest(pr);
    const comment = new Comment(context, context.issue().number);
    await comment.append(`Running ${code("/qa")}...`);
    await setup(comment);
    try {
      await updatePullRequest(pr);
    } catch (e) {
      await handleError(
        comment,
        `I failed to bring ${pr.head.ref} up-to-date with ${
          pr.base.ref
        }. Please resolve conflicts before running ${code("/qa")} again.`,
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
          comment.separator();
          await comment.append([
            success("Done"),
            info(
              `Comment ${code("/passed-qa")} or ${code(
                "/failed-qa"
              )} once you have verified the changes. Merging this pull request will deploy it to ${code(
                config.productionEnvironment
              )}.`
            ),
          ]);
        } catch (e) {
          await setCommitStatus(context, pr, "failure");
          throw e;
        }
      }
    );
  } else {
    const prNumber = deploymentPullRequestNumber(deployment);
    const message = `#${prNumber} is currently deployed ${maybeComponentName()}to ${code(
      environment
    )}. It must be merged or closed before this pull request can be deployed.`;
    await Comment.create(context, pr.number, warning(mention(message)));
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
      // If bases are the same and it is open, invalidate it
      if (deployedPr.data.state !== "open") {
        log.debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) is closed - nothing to do`
        );
      } else if (baseRef === deployedPr.data.base.ref) {
        log.debug(
          `The pull request currently deployed to ${environment} (#${deployedPr}) has the same base (${baseRef}) - invalidating it`
        );
        const body = [
          warning(
            `This pull request is no longer up-to-date with ${baseRef} (because #${prNumber} was just merged, which changed ${baseRef}).`
          ),
          `Run ${code("/qa")} to redeploy your changes to ${code(
            environment
          )} or ${code(
            "/skip-qa"
          )} if you want to ignore the changes in ${baseRef}.`,
          `Note that using ${code(
            "/skip-qa"
          )} will cause the new changes in ${baseRef} to be excluded when this pull request is merged, and they will not be deployed to ${code(
            config.productionEnvironment
          )}.`,
        ].join(" ");
        await Promise.all([
          setCommitStatus(context, deployedPr.data, "pending"),
          Comment.create(context, deployedPrNumber, body),
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

  const comment = new Comment(context, context.issue().number);
  const version = prodDeployment.ref;
  const environment = preProductionEnvironment;

  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: context.issue().number },
    async () => {
      await deploy(comment, version, environment);
      await verify(comment, version, environment);
    }
  );

  await comment.append(
    success(
      `Reset ${code(
        preProductionEnvironment
      )} ${maybeComponentName()}to version ${version} from ${code(
        productionEnvironment
      )}.`
    )
  );
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

  const comment = new Comment(context, context.issue().number);
  await comment.append(`Running ${code(`/verify ${environment}`)}...`);

  if (!deployment) {
    await comment.append(
      warning(
        `I wasn't able to find a deployment for ${code(environment)} to verify.`
      )
    );
    return;
  }

  await checkoutPullRequest(pr);

  await setup(comment);

  try {
    const version = deployment.ref;
    await verify(comment, version, environment);

    if (environment === config.preProductionEnvironment) {
      if (deploymentPullRequestNumber(deployment) === pr.number) {
        await setDeploymentStatus(context, deployment.id, "success");
      } else {
        await comment.append(
          warning(
            `This pull request is not currently deployed to ${code(
              environment
            )}. You can use ${code("/qa")} to deploy it to ${code(
              environment
            )}.`
          )
        );
      }
    }

    await comment.append(success("Done"));
  } catch (e) {
    await handleError(
      comment,
      `verification of ${code(environment)} failed`,
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
  const environment = providedEnvironment || config.preProductionEnvironment;
  const deployment = await findLastDeploymentForPullRequest(
    context,
    config.preProductionEnvironment,
    pr.number
  );

  const comment = new Comment(context, context.issue().number);

  if (!deployment) {
    await comment.append([
      `Running ${code(`/deploy`)}...`,
      warning(`I wasn't able to find the latest release for #${pr.number}`),
    ]);
    return;
  }

  await checkoutPullRequest(pr);

  const version = providedVersion || deployment.ref;

  await comment.append(
    `Running ${code(`/deploy ${environment} ${version}`)}...`
  );

  await setup(comment);

  // Cross-notify if release came from another PR
  const firstDeployment = await findFirstDeploymentForRelease(
    context,
    config.preProductionEnvironment,
    version
  );
  const firstDeploymentPrNumber = deploymentPullRequestNumber(firstDeployment);
  if (firstDeploymentPrNumber && firstDeploymentPrNumber !== pr.number) {
    const otherPrMessage = `Deploy ${maybeComponentName()}${version} to ${code(
      environment
    )} triggered via ${link(code("/deploy"), comment.url)}.`;
    await Comment.create(context, firstDeploymentPrNumber, otherPrMessage);
  }

  await createDeploymentAndSetStatus(
    context,
    version,
    environment,
    { pr: pr.number },
    async () => {
      await release(comment, version);
      await deploy(comment, version, environment);
      await verify(comment, version, environment);
      await comment.append(success("Done"));
    }
  );
};

const handleRollbackCommand = async (context: Context, pr: PullRequest) => {
  const comment = new Comment(context, context.issue().number);
  await comment.append(`Running ${code(`/rollback`)}...`);

  const environment = config.productionEnvironment;
  const currentDeployment = await findDeployment(context, environment);
  const deployedPrNumber = deploymentPullRequestNumber(currentDeployment);

  if (deployedPrNumber !== pr.number) {
    await comment.append(
      warning(
        `This pull request is not currently deployed to ${code(
          environment
        )} (#${deployedPrNumber} is) - not rolling back.`
      )
    );
    return;
  }

  const previousDeployment = await findPreviousDeployment(context, environment);

  if (!previousDeployment) {
    await comment.append(
      warning(
        `I was not able to find a previous deployment for ${code(
          environment
        )} to roll back to.`
      )
    );
    return;
  }

  await rollback(context, comment, pr, previousDeployment);
};

const commentPullRequestNotDeployed = async (context: Context) => {
  return Comment.create(
    context,
    context.issue().number,
    `This pull request has not been deployed yet. You can use ${code(
      "/qa"
    )} to deploy it to ${code(config.preProductionEnvironment)} or ${code(
      "/skip-qa"
    )} to not deploy this pull request.`
  );
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

  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      if (config.isComponent) {
        await context.github.issues.addLabels(
          context.issue({ labels: [componentLabel()] })
        );
      }
    }
  );

  app.on(["issue_comment.created", "pull_request.opened"], async (context) => {
    const pr = await context.github.pulls.get(context.issue());

    if (!pr) {
      log.debug(
        `No pull request associated with comment ${context.issue()} - quitting`
      );
      return;
    }

    if (pr.data.state !== "open") {
      log.debug(
        `Pull request associated with comment ${context.issue()} is not open - quitting`
      );
      return;
    }

    const labels = pr.data.labels.map((l) => l.name);
    if (config.isComponent && !labels.includes(componentLabel())) {
      log.debug(
        `Pull request does not contain changes for ${config.componentName} - quitting`
      );
      return;
    }

    switch (true) {
      case commandMatches(context, "skip-qa"): {
        await Promise.all([
          reactToComment(context, "eyes"),
          setCommitStatus(context, pr.data, "success"),
        ]);
        break;
      }

      case commandMatches(context, "qa"): {
        await Promise.all([
          reactToComment(context, "eyes"),
          setCommitStatus(context, pr.data, "pending"),
          handleQACommand(context, pr.data),
        ]);
        break;
      }

      case commandMatches(context, "failed-qa"): {
        await reactToComment(context, "eyes");
        if (
          await pullRequestHasBeenDeployed(
            context,
            config.preProductionEnvironment,
            pr.data.number
          )
        ) {
          await setCommitStatus(context, pr.data, "failure");
        } else {
          await commentPullRequestNotDeployed(context);
        }
        break;
      }

      case commandMatches(context, "passed-qa"): {
        await reactToComment(context, "eyes");
        if (
          await pullRequestHasBeenDeployed(
            context,
            config.preProductionEnvironment,
            pr.data.number
          )
        ) {
          await setCommitStatus(context, pr.data, "success");
        } else {
          await commentPullRequestNotDeployed(context);
        }
        break;
      }

      case commandMatches(context, "verify"): {
        const [providedEnvironment] = commandParameters(context);
        await Promise.all([
          reactToComment(context, "eyes"),
          handleVerifyCommand(context, pr.data, providedEnvironment),
        ]);
        break;
      }

      case commandMatches(context, "deploy"): {
        const [providedEnvironment, providedVersion] = commandParameters(
          context
        );
        await Promise.all([
          reactToComment(context, "eyes"),
          handleDeployCommand(
            context,
            pr.data,
            providedEnvironment,
            providedVersion
          ),
        ]);
        break;
      }

      case commandMatches(context, "rollback"): {
        await Promise.all([
          reactToComment(context, "eyes"),
          handleRollbackCommand(context, pr.data),
        ]);
        break;
      }

      default: {
        if (looksLikeACommand(context)) {
          await reactToComment(context, "confused");
        }
        log.debug(`Unknown command: ${commentBody(context)}`);
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
