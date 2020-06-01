# actions-deploy

GitHub Actions-based Release and Deployment.

- release and deployment is driven from the pull request and a pull request is the deployable unit
  - each release is tied to a pull request
  - a [roll back involves re-deploying a previous pull request](./docs/workflows.md#rollback-production-deploy)
- the exact same release that is verified in the pre-production environment is deployed to the production environment
- pull requests move through the pre-production environment and to production one at a time in a continuous deployment style
- existing tools are used to perform release, deployment, and verification
  – this workflow simply adds a way to orchestrate this process

## Usage

Create a workflow in your repository (such as `.github/workflows/deployment.yaml`):

```yaml
on:
  pull_request:
    types: [opened, reopened, closed, synchronize]
    # Scope to certain paths if more than one component in a repository uses the actions-deploy workflow
    # paths:
    #   - packages/my-component/*
  push:
    branches: [master]
    # Scope to certain paths if more than one component in a repository uses the actions-deploy workflow
    # paths:
    #   - packages/my-component/*
  issue_comment: {}

# Provide a name if more than one component in a repository use the actions-deploy workflow:
# env:
#   ACTIONS_DEPLOY_NAME: my-component

name: Deployment
jobs:
  # Deployment automation tasks
  automation:
    name: Automation
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GEMFURY_TOKEN: ${{ secrets.GEMFURY_TOKEN }}
    # Should be inverse of `if` below
    if: "!(github.event_name == 'push' || (github.event_name == 'issue_comment' && !(startsWith(github.event.comment.body, '/qa') || startsWith(github.event.comment.body, '/deploy') || startsWith(github.event.comment.body, '/verify') || startsWith(github.event.comment.body, '/rollback'))))"
    steps:
    - uses: unbounce/actions-deploy@master
      if: "(!env.ACTIONS_DEPLOY_NAME || github.event_name != 'issue_comment' || contains(github.event.issue.labels.*.name, 'actions-deploy/${{env.ACTIONS_DEPLOY_NAME}}'))"
      with:
        release: make release # or: npm run release
        deploy: make deploy # or: npm run deploy --environment "$ENVIRONMENT" --version "$VERSION"
        verify: make end-to-end-tests

  # Deployment tasks - this is where the actual deployment takes place
  # Runs on self-hosted runners so that it can have access to AWS resources for deployments
  deployment:
    name: Deployment
    runs-on: self-hosted
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GEMFURY_TOKEN: ${{ secrets.GEMFURY_TOKEN }}
    # Should be inverse of `if` above
    if: "(github.event_name == 'push' || (github.event_name == 'issue_comment' && !(startsWith(github.event.comment.body, '/qa') || startsWith(github.event.comment.body, '/deploy') || startsWith(github.event.comment.body, '/verify') || startsWith(github.event.comment.body, '/rollback'))))"
    steps:
    - uses: actions/checkout@master
      if: "(!env.ACTIONS_DEPLOY_NAME || github.event_name != 'issue_comment' || contains(github.event.issue.labels.*.name, 'actions-deploy/${{env.ACTIONS_DEPLOY_NAME}}'))"
    - uses: unbounce/actions-deploy@master
      if: "(!env.ACTIONS_DEPLOY_NAME || github.event_name != 'issue_comment' || contains(github.event.issue.labels.*.name, 'actions-deploy/${{env.ACTIONS_DEPLOY_NAME}}'))"
      with:
        setup: make deps # or: npm ci
        release: make release # or: npm run release
        deploy: make deploy # or: npm run deploy --environment "$ENVIRONMENT" --version "$VERSION"
        verify: make end-to-end-tests # or: npm run end-to-end-tests
```

The main way to interact with this automation is to comment `/qa` on a pull
request. This will create a release and deploy it to the pre-production
environment. Then `/passed-qa` or `/failed-qa` should be commented once manual
verification of the release is complete. Merging the pull request after
commenting `/qa` will deploy the release to the production environment.

⚠️ It is recommended that the "QA" status check is required in [branch protection](https://help.github.com/en/github/administering-a-repository/about-protected-branches) for the main branch of the reposiory.

ℹ️See also [docs/workflows.md](./docs/workflows.md).

### Multiple Components

Monorepos or repositories that have more than one component must specify a
unique name for the component (specified in the `ACTIONS_DEPLOY_NAME`
environment variable). Specifying a name will create a separate GitHub
Deployment environment to track deployments for that component. For example, a
name of `infrastructure` will be tracked as `production[infrastructure]`.

The workflow should be scoped to paths that are relevant for the component.

```yaml
on:
  pull_request:
    types: [opened, reopened, closed, synchronize]
    paths:
      - packages/my-component/*
  push:
    branches: [master]
    paths:
      - packages/my-component/*
  issue_comment: {}

env:
  ACTIONS_DEPLOY_NAME: infrastructure
```

**Note** that you may choose to omit the `ACTIONS_DEPLOY_NAME` for the main
component of your repository, but that only one actions-deploy workflow per
repository can omit this property.

### Commands

Release and deployment automation is driven by commenting on the pull request.

|Command|Notes|
|-------|-----|
|`/qa`|Create a release, deploy it to the pre-production environment and run `verify` command|
|`/passed-qa`|Set "QA" status check to "success"|
|`/failed-qa`|Set "QA" status check to "failed"|
|`/verify`, `/verify <environment>`|(Re-)run `verify` command against an environment (environment defatuls to pre-production environment)|
|`/deploy`, `/deploy <environment>`, `/deploy <environment> <version>`|(Re-)deploy a release to an environment and run `verify` command - `/qa` must have already been run on the pull request (environment defaults to pre-production environment, version defaults to latest release for the pull request)|
|`/rollback`|If a pull request is the latest to be deployed to the production environment, this command will roll back the production environment to the previous version|
|`/help`|Show help message|

### Configuration

This action can be configured via the `with` section with the following configuration options:

|Name|Required|Default|Notes|
|----|--------|-------|-----|
|`release`|Yes||Command to run to perform release. Command is expected to create a release identified by the short git sha (`git rev-parse --short HEAD`). Environment variable `VERSION` will be available, or `git rev-parse --short HEAD` can be run to generate version.|
|`deploy`|Yes||Command to run to perform deploy. Environment variables `ENVIRONMENT` and `VERSION` will be available.|
|`setup`|No||Command to run before release, deploy, or verify|
|`verify`|No||Command to run to verify a deployment. Environment variables `ENVIRONMENT` and `VERSION` will be available.|
|`production-environment`|No|`production`||
|`pre-production-environment`|No|`integration`||
