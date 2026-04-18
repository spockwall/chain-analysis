# CI/CD

This repository separates validation from deployment. Pull requests and normal branch pushes run CI only. Production deployment is limited to release branches and waits for the GitHub `production` environment approval gate.

## Branch Roles

- `feature/*` and other working branches: run CI only.
- `develop`: integration and validation branch; run CI only and never deploy to the production-like machine.
- `release/*`: release candidate branch; run predeploy verification and, after approval, deploy to production.

## CI

The `CI` workflow lives at `.github/workflows/ci.yml`.

It runs on all pull requests and all branch pushes. It does not use deployment secrets, SSH, rsync, or remote server commands.

The workflow validates:

- Frontend: dependency install, lint, Vitest command validation, Vite build, production Docker image build.
- Backend: dependency install with dev extras, critical Ruff checks, advisory mypy output, pytest against local Compose infrastructure, production Docker image build.
- Rust ETL: rustfmt, clippy with narrow allowances for existing argument-count/dead-code debt, tests, release build, Docker builds for `ingest` and `process`.
- Compose: local Compose config and production Compose config using placeholder CI values.

Production Compose validation uses placeholder values and `docker compose config --quiet` so rendered secrets are not printed.

## Production Deployment

The `Production Deployment` workflow lives at `.github/workflows/production-deployment.yml`.

It runs on pushes to `release/*` branches. Manual dispatch is allowed only when the selected ref is also a `release/*` branch; other refs fail before SSH credentials are touched.

The deployment flow is:

1. Run `predeploy-verify` on GitHub Actions.
2. Wait for the GitHub `production` environment approval gate.
3. Set up SSH with strict file permissions and known-host verification.
4. SSH to the production machine.
5. Check out and reset to the matching `release/*` branch.
6. Run `scripts/deploy_production_release.sh`.
7. Validate production Compose with `--quiet`.
8. Pull image-based services, build application services, restart with Docker Compose.
9. Check backend and frontend health.
10. Print service status without dumping application logs or rendered configuration.

The deployment script avoids destructive operations such as deleting volumes, pruning images, or running `docker compose down`.

## Required GitHub Secrets

Configure these secrets in GitHub for the `production` environment:

- `SSH_PRIVATE_KEY`
- `SSH_KNOWN_HOSTS`
- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PATH`

Do not print these values in workflow logs. The workflow validates only whether required settings are present.

## Required Server Environment

The production machine must have a `.env` file in `DEPLOY_PATH`. The deploy script checks that these variable names exist and have non-empty values, but it never prints the values:

- `ENVIRONMENT`
- `NEO4J_USER`
- `NEO4J_PASSWORD`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `REDIS_PASSWORD`
- `MINIO_ROOT_USER`
- `MINIO_ROOT_PASSWORD`
- `MINIO_BUCKET`
- `JWT_SECRET_KEY`
- `ALLIUM_API_KEY`
- `ETHERSCAN_API_KEY`

## Rollback

Rollback is manual and intentionally conservative:

1. Identify the previous known-good release commit or branch.
2. Move or recreate a `release/*` branch at that commit.
3. Run the production deployment workflow again.

The deployment script logs the previous and current commit SHAs to make rollback decisions easier without exposing credentials.
