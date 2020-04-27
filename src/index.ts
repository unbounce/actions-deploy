import { Application, Context, GitHubAPI } from "probot";
import adapt from "probot-actions-adapter";

import { commandMatches, createComment, setCommitStatus } from "./utils";
import { debug, error } from "./logging";
import { shell, shellOutput, ShellError } from "./shell";
import * as comment from "./comment";

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
// tslint:disable-next-line:array-type
type UnwrapList<T> = T extends Array<infer U> ? U : T;
type Deployment = UnwrapList<
  UnwrapPromise<ReturnType<GitHubAPI["repos"]["listDeployments"]>>["data"]
>;
type PullRequest = UnwrapList<
  UnwrapPromise<ReturnType<GitHubAPI["pulls"]["get"]>>["data"]
>;
type DeploymentStatusState = NonNullable<
  UnwrapList<Parameters<GitHubAPI["repos"]["createDeploymentStatus"]>>
>["state"];

const input = (name: string) => {
  const envName = `INPUT_${name}`.toUpperCase().replace(" ", "_");
  const value = process.env[envName];
  if (typeof value === "undefined") {
    throw new Error(`Input ${name} was not provided`);
  }
  return value;
};

const config = {
  statusCheckContext: "QA",
  productionEnvironment: input("production-environment"),
  preProductionEnvironment: input("pre-production-environment"),
  deployCommand: input("deploy"),
  releaseCommand: input("release"),
};

const errorMessage = (e: any) => {
  if (e instanceof Error && e.message) {
    return e.message;
  } else {
    return e.toString();
  }
};

// Deployments

const findDeployment = async (context: Context, environment: string) => {
  const deployments = await context.github.repos.listDeployments(
    context.repo({ environment })
  );
  if (deployments.data.length > 0) {
    return deployments.data[0];
  } else {
    return undefined;
  }
};

const setDeploymentStatus = (
  context: Context,
  deploymentId: number,
  state: DeploymentStatusState
) =>
  context.github.repos.createDeploymentStatus(
    context.repo({ deployment_id: deploymentId, state })
  );

const createDeployment = (
  context: Context,
  ref: string,
  environment: string,
  payload: object
) =>
  context.github.repos.createDeployment(
    context.repo({
      task: "deploy",
      payload: JSON.stringify(payload),
      required_contexts: [],
      auto_merge: true,
      environment,
      ref,
    })
  );

const deploymentPullRequestNumber = (deployment?: Deployment) =>
  JSON.parse(deployment ? ((deployment.payload as unknown) as string) : "{}")
    .pr;

const environmentIsAvailable = async (
  context: Context,
  deployment?: Deployment
) => {
  if (deployment) {
    const prNumber = deploymentPullRequestNumber(deployment);
    if (typeof prNumber === "number") {
      if (prNumber !== context.issue().number) {
        const otherPr = await context.github.pulls.get(
          context.repo({ pull_number: prNumber })
        );
        if (otherPr && otherPr.data.state === "open") {
          return false;
        }
      }
    }
  }
  return true;
};

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

const checkoutPullRequest = (pr: PullRequest) => {
  const { sha, ref } = pr.head;
  return shell([
    `git fetch origin ${sha}:refs/remotes/origin/${ref}`,
    `git checkout -b ${ref}`,
  ]);
};

const updatePullRequest = async (pr: PullRequest) => {
  const currentCommit = pr.head.sha;
  const currentBranch = pr.head.ref;
  const baseBranch = pr.base.ref;
  try {
    return await shell([
      `git fetch --unshallow origin ${baseBranch}`,
      `git fetch --unshallow origin ${currentBranch}`,
      `git pull --rebase origin ${baseBranch}`,
      `git push --force-with-lease origin ${currentBranch}`,
    ]);
  } catch (e) {
    // If rebase wasn't clean, reset and try regular merge
    console.log("Rebase failed, trying merge instead");
    return shell([
      `git reset --hard ${currentCommit}`,
      `git pull origin ${baseBranch}`,
      `git push origin ${currentBranch}`,
    ]);
  }
};

const getShortCommit = () =>
  shellOutput("git rev-parse --short HEAD").then((s) => s.toString().trim());

const handleError = async (context: Context, text: string, e: Error) => {
  const message = `${text}: ${comment.code(errorMessage(e))}`;
  const body = [comment.mention(`${message} (${comment.runLink("Details")})`)];
  if (e instanceof ShellError) {
    body.push(comment.details("Output", comment.codeBlock(e.output)));
  }
  await createComment(context, body);
  error(message);
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
            `I failed to bring ${pr.head.ref} up-to-date with ${pr.base.ref}`,
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
