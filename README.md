# actions-deploy

GitHub Actions-based Release and Deployment.

## Usage

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
    steps:
    - uses: actions/checkout@master
    - uses: unbounce/actions-deploy@master
      with:
        type: ui # or 'lambda' or 'kube'
        # Optional parameters with defaults:
        # master-branch: master
        # production-environment: production
        # pre-production-environment: integration
```
