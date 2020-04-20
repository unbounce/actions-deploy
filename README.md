# actions-deploy

GitHub Actions-based Release and Deployment.

## Usage

Create a workflow in your repository (such as `.github/workflows/deployment.yaml`):

```yaml
on:
  pull_request:
    types: [opened, reopened]
  push:
    branches: [master]
  issue_comment: {}

name: Deployment
jobs:
  automation:
    name: Deployment Automation
    runs-on: ubuntu-latest
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GEMFURY_TOKEN: ${{ secrets.GEMFURY_TOKEN }}
    # Should be inverse of `if` below
    if: "!((github.event_name == 'push' && github.ref == 'master') || (startsWith(github.event_name, 'issue_comment') && contains(github.event.comment, '/qa')))"
    steps:
    - uses: actions/checkout@master
    - uses: unbounce/actions-deploy@master
      with:
        release: make release # or: npm run release
        deploy: make deploy # or: npm run deploy --environment "$ENVIRONMENT" --version "$VERSION"

  # Events that require access to AWS resources for deployments
  deployment:
    name: Deployment
    runs-on: self-hosted
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      GEMFURY_TOKEN: ${{ secrets.GEMFURY_TOKEN }}
    # Should be inverse of `if` above
    if: "(github.event_name == 'push' && github.ref == 'master') || (startsWith(github.event_name, 'issue_comment') && contains(github.event.comment, '/qa'))"
    steps:
    - uses: actions/checkout@master
    - uses: unbounce/actions-deploy@master
      with:
        release: make release # or: npm run release
        deploy: make deploy # or: npm run deploy --environment "$ENVIRONMENT" --version "$VERSION"
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
