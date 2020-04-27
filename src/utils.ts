import type { Octokit } from "@octokit/rest";
import { Context } from "probot";

import { config } from "./config";
import * as comment from "./comment";
import { ShellError } from "./shell";
import { error } from "./logging";
import { Deployment, DeploymentStatusState } from "./types";

// From https://github.com/probot/commands/blob/master/index.js
export const commandMatches = (context: Context, match: string): boolean => {
  // tslint:disable-next-line:no-shadowed-variable
  const { comment, issue, pull_request: pr } = context.payload;
  const command = (comment || issue || pr).body.match(/^\/([\w-]+)\s*?(.*)?$/m);
  return command && command[1] === match;
};

export const createComment = (context: Context, body: string[]) => {
  const issueComment = context.issue({ body: body.join("\n") });
  return context.github.issues.createComment(issueComment);
};

export const setCommitStatus = async (
  context: Context,
  state: Octokit["ReposCreateStatusParams"]["state"]
) => {
  const pr = await context.github.pulls.get(context.issue());
  const { sha } = pr.data.head;
  if (pr) {
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

export const environmentIsAvailable = async (
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

const errorMessage = (e: any) => {
  if (e instanceof Error && e.message) {
    return e.message;
  } else {
    return e.toString();
  }
};

export const handleError = async (context: Context, text: string, e: Error) => {
  const message = `${text}: ${comment.code(errorMessage(e))}`;
  const body = [comment.mention(`${message} (${comment.runLink("Details")})`)];
  if (e instanceof ShellError) {
    body.push(comment.details("Output", comment.codeBlock(e.output)));
  }
  await createComment(context, body);
  error(message);
};
