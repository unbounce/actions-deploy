import { exec } from "child_process";
import { Context } from "probot";
import { DeploymentStatusState, Deployment } from "./types";
import { DeploymentType } from "./config";

export const findDeployment = async (context: Context, environment: string) => {
  const deployments = await context.github.repos.listDeployments(
    context.repo({ environment })
  );
  if (deployments.data.length > 0) {
    return deployments.data[0];
  } else {
    return undefined;
  }
};

export const setDeploymentStatus = (
  context: Context,
  deploymentId: number,
  state: DeploymentStatusState
) =>
  context.github.repos.createDeploymentStatus(
    context.repo({ deployment_id: deploymentId, state })
  );

export const createDeployment = (
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

export const deploymentPullRequestNumber = (deployment?: Deployment) =>
  JSON.parse(deployment ? ((deployment.payload as unknown) as string) : "{}")
    .pr;

export const environmentIsAvailable = (
  context: Context,
  deployment?: Deployment
) => {
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

export const handleDeploy = async (
  context: Context,
  ref: string,
  environment: string,
  payload: object,
  commands: string[]
) => {
  // Resources created as part of an Action can not trigger other actions, so we
  // can't handle the deployment as part of `app.on('deployment')`
  const {
    data: { id },
  } = await createDeployment(context, ref, environment, payload);
  try {
    for (const command of commands) {
      await new Promise((resolve, reject) => {
        // TODO stream output, shell escape deployCommand
        exec(command, (error, stdout, stderr) => {
          if (stdout) {
            console.log(stdout);
          }
          if (stderr) {
            console.error(stderr);
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    await setDeploymentStatus(context, id, "success");
  } catch (e) {
    await setDeploymentStatus(context, id, "error");
    throw e;
  }
};

export const deployCommands: {
  [K in DeploymentType]: { deploy: string; release: string };
} = {
  npm: { deploy: "echo npm run deploy", release: "echo npm run release" },
  make: { deploy: "echo make deploy", release: "echo make release" },
};
