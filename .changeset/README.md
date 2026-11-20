# Changesets

This folder is managed by [Changesets](https://changesets.dev) and tracks the
changes queued for the next release.

- `bun run changeset` — describe a change and pick a semver bump
- `bun run version` — apply queued changesets (bumps version + changelog)
- `bun run stage` — stage the current version for publishing on npm
- `bun run tag` — create git tags for released versions

Pull requests with pending changesets get a "Version Packages" PR from CI.
Merging that PR bumps the version and stages the package on npm; a maintainer
then approves it with 2FA before it goes live.
