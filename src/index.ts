import { spawn, exec } from "child_process";
import { Application, Context, GitHubAPI } from "probot";
import adapt from "probot-actions-adapter";

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
  // tslint:disable:no-shadowed-variable
  const { comment, issue, pull_request: pr } = context.payload;
  const command = (comment || issue || pr).body.match(/^\/([\w]+)\b *(.*)?$/m);
  return command && command[1] === match;
};

const createComment = (context: Context, body: string[]) => {
  const issueComment = context.issue({ body: body.join("\n") });
  return context.github.issues.createComment(issueComment);
};

// GitHub Actions Annotations
// const warning = (message: string) => console.log(`::warning::${message}`);
const error = (message: string) => console.log(`::error::${message}`);
const debug = (message: string) => console.log(`::debug::${message}`);

const errorMessage = (e: any) => {
  if (e instanceof Error && e.message) {
    return e.message;
  } else {
    return e.toString();
  }
};

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

class ShellError extends Error {
  constructor(public message: string, public output: string) {
    super(message);
  }
}

const shell = async (
  commands: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> => {
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv,
    };
    const options = { env, cwd: process.cwd() };
    // TODO shell escape command
    const child = spawn(
      "bash",
      ["-e", "-x", "-c", commands.join("\n")],
      options
    );
    child.stdout.on("data", (data) => {
      const str = data.toString();
      output.push(str);
      console.log(str);
    });
    child.stderr.on("data", (data) => {
      const str = data.toString();
      output.push(str);
      console.error(str);
    });
    child.on("error", (e) => {
      reject(e);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(output.join("\n"));
      } else {
        reject(
          new ShellError(
            `Deploy command exited with status code ${code}`,
            output.join("\n")
          )
        );
      }
    });
  });
};

const shellOutput = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, (e, stdout, stderr) => {
      if (stderr) {
        console.error(stderr);
      }
      if (stdout) {
        console.log(stdout);
      }
      if (e) {
        reject(new ShellError(e.message, [stdout, stderr].join("\n")));
      } else {
        resolve(stdout);
      }
    });
  });
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
    `git checkout ${ref}`,
  ]);
};

const updatePullRequest = (pr: PullRequest) => {
  const currentCommit = pr.head.sha;
  const currentBranch = pr.head.ref;
  const baseBranch = pr.base.ref;
  try {
    return shell([
      `git pull --rebase origin ${baseBranch}`,
      `git push --force-with-lease origin ${currentBranch}`,
    ]);
  } catch (e) {
    // If rebase wasn't clean, reset and try regular merge
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
  const message = `${text}: ${errorMessage(e)}`;
  const body = [comment.mention(`${message} (${comment.runLink("Details")})`)];
  if (e instanceof ShellError) {
    body.push(comment.details("Output", comment.codeBlock(e.output)));
  }
  await createComment(context, body);
  error(message);
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
      const environment = config.preProductionEnvironment;
      const deployment = await findDeployment(context, environment);
      if (commandMatches(context, "qa")) {
        if (environmentIsAvailable(context, deployment)) {
          try {
            await updatePullRequest(pr.data);
          } catch (e) {
            handleError(
              context,
              `I failed to bring ${pr.data.head.ref} up-to-date with ${pr.data.base.ref}`,
              e
            );
            return;
          }

          try {
            const { ref } = pr.data.head;
            await checkoutPullRequest(pr.data);
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
            handleError(
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
    } else {
      debug(`No pull request associated with comment ${context.issue()}`);
    }
  });
};

adapt(probot);
