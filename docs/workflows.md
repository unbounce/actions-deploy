## Standard Workflow

1. Create a pull request containing the changes you would like to deploy
1. Comment `/qa`
     - This will run the `release`, `deploy`, and `verify` commands for the pre-production environment
     - If the `verify` command fails, the pre-production environment will be left as-is
     - If the `deploy` or `verify` commands fail, the pre-production environment may be left as-is so that you can investigate the failed `deploy` or `verify` and may in a partially deployed state
     - If this process encounters an error, the QA status check will be set to "failed", otherwise it will be left as "pending"
1. Perform any manual verification needed in the pre-production environment
     - If the changes are good, comment `/passed-qa` (which will set the QA status check to "passed")
     - If there are issues, comment `/failed-qa` (which wil set the QA status check to "failed")
1. When you are ready to deploy to production – merge the pull request
     - This will run the `deploy`, and `verify` commands for the production environment, using the latest release for the pull request

- `/qa` can be run multiple times on a pull request, if needed
- If a pull request is currently deployed to the pre-production environment, pushing new changes to it will re-run the `release`, `deploy`, and `verify` commands

## Rollback Pre-Production Deploy

1. Close the pull request
     - This will run the `deploy` and `verify` commands for the pre-production environment using the release version from the latest production deploy

- The pull request can be reopened if needed

## Rollback Production Deploy

1. Find the pull request you want to roll back to (typically the previously merged pull request)
     - You can find a history of deployments and their releated pull request on the "Environments" page of your repository
1. Comment `/deploy production`
     - This will run the `deploy` and `verify` commands for the production environment using the latest release for the pull request

## Deploying a Specific Version to an Environment

1. Find the pull request that created the release you want to deploy
1. Find the release version (the short commit sha)
1. Comment `/deploy <environment> <version>` (eg. `/deploy staging abc1234`)
     - This will run the `deploy` and `verify` commands for the provided environment and release version
