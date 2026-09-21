# CI/CD Pipeline Documentation

## Overview

This directory contains GitHub Actions workflows for automatically building and deploying the Astro static site to GitHub Pages using Bun.

## Workflows

### `static.yml` - Deploy Astro Site to GitHub Pages

This is the main deployment workflow that:

1. **Triggers** on:
   - Pushes to the `master` branch
   - Manual trigger via GitHub Actions tab (`workflow_dispatch`)

2. **Build Job**:
   - Checks out the repository
   - Sets up Bun (JavaScript runtime)
   - Installs dependencies via `bun install`
   - Runs validation checks (`bun run check`) including:
     - Physics validation
     - Render checks
     - Layout audit
     - Contact validation
   - Builds the Astro site (`bun run build`)
   - Uploads the `./dist` folder as a deploy artifact

3. **Deploy Job**:
   - Depends on successful build completion
   - Deploys the artifact to GitHub Pages
   - Provides the deployed URL as output

## Required GitHub Settings

Before the workflow can deploy successfully, ensure:

1. **Enable GitHub Pages**:
   - Go to repository Settings → Pages
   - Set source to "GitHub Actions"

2. **Repository Permissions**:
   - The workflow requires `pages: write` and `id-token: write` permissions
   - These are configured in the workflow file

3. **Environment Protection** (optional):
   - The `github-pages` environment is used for deployment
   - Can add branch/Deployment branch rules in Settings → Environments

## Bun-Specific Features

- Uses `oven-sh/setup-bun@v2` for fast Bun installation
- All scripts use `bun x` to run Astro CLI commands
- `bun install` is faster than npm/yarn for dependency installation
- Build process is optimized for the `semicoduct-presentation` project

## Local Testing

Before pushing, you can test locally:

```bash
# Install dependencies
bun install

# Run all checks
bun run check

# Build the site
bun run build

# Preview locally
bun run preview
```

## Troubleshooting

### Build Failures
- Check that all validation scripts pass locally first
- Ensure `bun install` completes without errors
- Verify Astro build output goes to `./dist`

### Deployment Failures
- Verify GitHub Pages is enabled in repository settings
- Check that the `github-pages` environment is properly configured
- Review the workflow run logs in Actions tab

### Permission Errors
- Ensure the workflow has correct permissions in the YAML
- Check repository Settings → Actions → General settings
