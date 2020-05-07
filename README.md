# actions-deploy

GitHub Actions-based Release and Deployment.

## Usage

Create a workflow in your repository (such as `.github/workflows/deployment.yaml`):

```yaml
on:
  pull_request:
    types: [opened, reopened, closed, synchronize]
  push:
    branches: [master]
  issue_comment: {}

name: Deployment
jobs:

  # Deployment automation tasks
  automation:
    name: Deployment Automation
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GEMFURY_TOKEN: ${{ secrets.GEMFURY_TOKEN }}
    # Should be inverse of `if` below
    if: "!((github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged) || (startsWith(github.event_name, 'issue_comment') && contains(github.event.comment.body, '/qa')))"
    steps:
    # These tasks do not actually need a copy of the repository because it only performs automation tasks with the GitHub API
    # - uses: actions/checkout@master
    - uses: unbounce/actions-deploy@master
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
    if: "((github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged) || (startsWith(github.event_name, 'issue_comment') && contains(github.event.comment.body, '/qa')))"
    steps:
    - uses: actions/checkout@master
    - uses: unbounce/actions-deploy@master
      with:
        release: make release # or: npm run release
        deploy: make deploy # or: npm run deploy --environment "$ENVIRONMENT" --version "$VERSION"
        verify: make end-to-end-tests
```

### Configuration

This action can be configured via the `with` section with the following configuration options:

|Name|Required|Default|Notes|
|----|--------|-------|-----|
|`release`|Yes||Command to run to perform release. Command is expected to create a release identified by the short git sha (`git rev-parse --short HEAD`). Environment variable `VERSION` will be available, or `git rev-parse --short HEAD` can be run to generate version.|
|`deploy`|Yes||Command to run to perform deploy. Environment variables `ENVIRONMENT` and `VERSION` will be available.|
|`master-branch`|No|`master`||
|`production-environment`|No|`production`||
|`pre-production-environment`|No|`integration`||
