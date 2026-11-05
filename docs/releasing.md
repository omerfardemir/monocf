# Releasing

Change `version` in `package.json` and merge to `main`. Merging releases nothing. When you're ready, open **Actions**, choose **release**, and **Run workflow** on `main`. It refuses any other branch.

`.github/workflows/release.yml` works out what that version is still missing, runs the tests, publishes to npm, and creates the tag and the GitHub release, in that order. If nothing is missing, it says so and stops.

The repository stores no secrets. npm takes the job's OIDC token through trusted publishing, and the release uses `GITHUB_TOKEN`.

## The setup on npmjs.com

On npmjs.com, under the package's **Settings**, **Trusted publishing**, choose **GitHub Actions**:

| Field | Value |
|---|---|
| Organization or user | `omerfardemir`, the GitHub name and not the npm one |
| Repository | `monocf` |
| Workflow filename | `release.yml`, the filename only |
| Environment | Blank |
| Allowed actions | Tick `npm publish` |

- npm doesn't check these when you save, and they're case-sensitive. A mistake shows up as a failed `publish` job, before any tag exists.
- A new entry expires if it hasn't published within 2 days, so create it just before the merge. If it expires, delete it and create it again.

## When a run fails

Run the workflow again, or use **Re-run all jobs**. Both work out again what's missing. Don't use "Re-run failed jobs": it keeps the first attempt's answer, so if a publish reached npm but its job still failed, it fails every time.

| What failed | What to do |
|---|---|
| `check` | Read its error. It stops on any unclear answer from npm or GitHub, so an outage can't look like a new version, and on a branch other than `main`. Run it again. |
| `test` | The run stopped before publishing. Fix it, merge the fix, and run it again. |
| `publish` | Search the log for `oidc`, as the step logs at verbose for this reason. Correct the setup above, and run it again. |
| `github-release` | npm already has the version. Run it again. If the fix has to go in this workflow, merge it first. |

A re-run uses the workflow file and the commit of its first attempt. A new run uses `main` as it is now.

A version that's on npm with no release gets its tag on the commit npm names (`gitHead`), not on whatever `main` is when the release is finally made. So the tag, the attached package and npm agree. If GitHub refuses that tag because the workflows have changed since, create the tag by hand on that commit, and re-run.

## After a release

- `v<version>` and both attached files are on the release, and the npm page shows provenance.
- `npm view monocf@<version> gitHead` equals the tag's commit.
