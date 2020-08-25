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

## Skipping the Workflow for a Pull Request

1. Comment `/skip-qa`
    - The QA status check to "passed" and no release or deploys will be done for this pull request

## Rollback Pre-Production Deploy

1. Close the pull request
     - This will run the `deploy` and `verify` commands for the pre-production environment using the release version from the latest production deploy

- The pull request can be reopened if needed

## Rollback Production Deploy

1. Navigate to the pull request that is currently deployed to the production environment
1. Comment `/rollback`
     - This will run the `deploy` and `verify` commands for the production environment using the release version from the previous successful production deploy

## Deploying a Specific Version to an Environment

1. Find the pull request that created the release you want to deploy
1. Find the release version (the short commit sha)
1. Comment `/deploy <environment> <version>` (eg. `/deploy staging abc1234`)
     - This will run the `deploy` and `verify` commands for the provided environment and release version
     - Omitting the environment will default to the pre-production environment
     - Omitting the version will default to the latest release version for the pull request

## Rerun Verify Command

If running the `verify` command fails while running `/qa`, or if you need to run it again for some other reason you can:

1. Find the pull request that contains the version of the `verify` command that you would like to run.
1. Comment `/verify` `/verify <environment>` (eg. `/verify production`)
     - This will run the `verify` command for the environment specified (or default to the pre-production environment)

## Rerun Release Command

If running the `release` command fails while running `/qa`, if you need to run it again for some other reason you can, or if you want to run the release command without deploying and verifying it right away:

1. Find the pull request that contains the version of the `release` command that you would like to run.
1. Comment `/release`
     - This will run the `release` command

## Deploy to a Custom Environment

If you want to deploy to an environment different than the configured `pre-production` and `production` environments, you can:

1. Run `/qa` (to release and deploy to the `pre-production` environment) or `/release` (to only create a release)
1. Run `/deploy <environment>` or `/deploy <environment> <version>`
     - Note that `version` must be specified if `/release` was used and not `/qa`
     - Omitting the version will default to the latest release version for the pull request
     - This will run the `deploy` and `verify` commands for the provided environment and release version
