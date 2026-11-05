# Releasing

Change `version` in `package.json` and merge to `main`. `.github/workflows/release.yml` then works out what that version is still missing, runs the tests, publishes to npm, and creates the tag and the GitHub release, in that order. A push with no new version does nothing.

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

Use **Re-run all jobs** unless the table says otherwise. It works out again what's missing, whereas "Re-run failed jobs" keeps the first attempt's answer. So if a publish reached npm but its job still failed, re-running only the failed jobs fails every time.

| What failed | What to do |
|---|---|
| `check` | Read its error. It stops on any unclear answer from npm or GitHub, so an outage can't look like a new version. Re-run. |
| `test` | The run stopped before publishing. Fix it, and merge the fix. |
| `publish` | Search the log for `oidc`, as the step logs at verbose for this reason. Correct the setup above, and re-run. |
| `github-release` | npm already has the version. Re-run. If the fix has to go in this workflow, merge it, and that push finishes the job. |

A run can only be re-run for 30 days. After that, any push to `main` does the same, as each run works out what's missing.

A version that's on npm with no release gets its tag on the commit npm names (`gitHead`), not on the later push that created it. So the tag, the attached package and npm agree. If GitHub refuses that tag because the workflows have changed since, create the tag by hand on that commit, and re-run.

## After a release

- `v<version>` and both attached files are on the release, and the npm page shows provenance.
- `npm view monocf@<version> gitHead` equals the tag's commit.
