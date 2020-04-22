import { spawn } from "child_process";
import { Application, Context, GitHubAPI } from "probot";
import adapt from "probot-actions-adapter";

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
// tslint:disable-next-line:array-type
type UnwrapList<T> = T extends Array<infer U> ? U : T;
type Deployment = UnwrapList<
  UnwrapPromise<ReturnType<GitHubAPI["repos"]["listDeployments"]>>["data"]
>;
type CommitStatusState = NonNullable<
  UnwrapList<Parameters<GitHubAPI["repos"]["createStatus"]>>
>["state"];
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

// From https://github.com/probot/commands/blob/master/index.js
const commandMatches = (context: Context, match: string): boolean => {
  const { comment, issue, pull_request: pr } = context.payload;
  const command = (comment || issue || pr).body.match(/^\/([\w]+)\b *(.*)?$/m);
  return command && command[1] === match;
};

const createComment = (context: Context, body: string) => {
  const issueComment = context.issue({ body });
  return context.github.issues.createComment(issueComment);
};

// GitHub Actions Annotations
// const warning = (message: string) => console.log(`::warning ${message}`);
// const error = (message: string) => console.log(`::error ${message}`)
const debug = (message: string) => console.log(`::debug ${message}`);

const setCommitStatus = async (context: Context, state: CommitStatusState) => {
  const pr = await context.github.pulls.get(context.issue());
  if (pr) {
    const { sha } = pr.data.head;
    return context.github.repos.createStatus(
      context.repo({
        sha,
        state,
        context: config.statusCheckContext,
      })
    );
  } else {
    return Promise.resolve();
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

const environmentIsAvailable = (context: Context, deployment?: Deployment) => {
  if (deployment) {
    const prNumber = deploymentPullRequestNumber(deployment);
    if (prNumber) {
      return prNumber === context.issue().number;
    } else {
      return true;
    }
  } else {
    return true;
  }
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
    await new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        VERSION: version,
        ENVIRONMENT: environment,
      };
      const options = { env, shell: "/bin/bash -e -x", cwd: process.cwd() };
      // TODO shell escape command
      const child = spawn(commands.join("\n"), options);
      child.stdout.on("data", console.log);
      child.stderr.on("data", console.error);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Deploy command exited with status code ${code}`));
        }
      });
    });
    await setDeploymentStatus(context, id, "success");
  } catch (e) {
    await setDeploymentStatus(context, id, "error");
    throw e;
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
    if (pr) {
      const { sha } = pr.data.head;
      const environment = config.preProductionEnvironment;
      const deployment = await findDeployment(context, environment);
      if (commandMatches(context, "qa")) {
        if (environmentIsAvailable(context, deployment)) {
          await handleDeploy(
            context,
            sha,
            environment,
            { pr: context.issue().number },
            [config.releaseCommand, config.deployCommand]
          );
        } else {
          const prNumber = deploymentPullRequestNumber(deployment);
          const message = `#${prNumber} is currently deployed to ${environment}. It must be merged or closed before this pull request can be deployed.`;
          await createComment(context, message);
        }
      }
    } else {
      debug(`No pull request associated with comment ${context.issue()}`);
    }
  });
};

adapt(probot);
