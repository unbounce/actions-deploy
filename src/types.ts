import { GitHubAPI } from "probot";

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

// tslint:disable-next-line:array-type
export type UnwrapList<T> = T extends Array<infer U> ? U : T;

export type Deployment = UnwrapList<
  UnwrapPromise<ReturnType<GitHubAPI["repos"]["listDeployments"]>>["data"]
>;
export type PullRequest = UnwrapList<
  UnwrapPromise<ReturnType<GitHubAPI["pulls"]["get"]>>["data"]
>;

export type CommitStatusState = NonNullable<
  UnwrapList<Parameters<GitHubAPI["repos"]["createStatus"]>>
>["state"];
export type DeploymentStatusState = NonNullable<
  UnwrapList<Parameters<GitHubAPI["repos"]["createDeploymentStatus"]>>
>["state"];
export type ReactionContent = NonNullable<
  UnwrapList<Parameters<GitHubAPI["reactions"]["createForIssue"]>>
>["content"];
