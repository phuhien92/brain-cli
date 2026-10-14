# Updates

brain is installed from GitHub, so "updating" means running the install command again:

```sh
npm install -g github:phuhien92/brain-cli              # the latest release on main
npm install -g github:phuhien92/brain-cli#v0.11.0      # a specific release
```

Your vault, `brain.json` and machine config are untouched; the next command refreshes the
index as usual. Releases are listed in [CHANGELOG.md](../CHANGELOG.md).

> Install from GitHub, not by name: `brain-cli` on npm is an unrelated project.

## How brain tells you a release is out

| Who | Where | When |
| --- | --- | --- |
| You, in a terminal | one line on **stderr** after a command | at most once a day, only when a newer release exists |
| An agent or script | `brain doctor` (and `brain doctor --json`): an `update` check that warns, with the command | whenever it asks |
| Anyone | `brain update` prints the install command; `brain update --check` asks GitHub right now | on request |

```text
brain 0.12.0 is available (you have 0.11.0): npm install -g github:phuhien92/brain-cli#v0.12.0
```

The terminal line never appears with `--json` or `--quiet`, in CI, in `brain context` (it runs
inside agents' startup hooks), or when stderr is not a terminal, so scripts and agents never
see it. brain never updates itself.

## What the check asks, and when

- **What:** one `GET https://api.github.com/repos/phuhien92/brain-cli/tags`. brain takes the
  highest plain version tag (`v1.2.3`; pre-releases are ignored). The request carries a
  `user-agent: brain-cli/<version>` header and nothing else: no install id, no vault, no
  command data. GitHub sees your IP address, as with any request.
- **When:** at most once a day, after a command has finished, in a detached background process.
  A command never waits for it, and a failed or offline check changes nothing.
- **Where the answer goes:** `update-check.json` in brain's state directory (`brain path update-check`):
  the newest release seen, when it checked, and when you were last told.

It is **on by default** because nothing is sent. That is the opposite of telemetry, which sends
usage events and is off until you say yes.

## Turning it off

Any one of these stops the request entirely:

- `BRAIN_NO_UPDATE_CHECK=1` in the environment;
- `"updates": { "check": false }` in the machine config (`brain path user-config`);
- answering no in `brain setup`, or `brain setup --yes --update-check no`.

It is also off whenever `CI` is set. `brain update` says whether the check is on and why not.

## For maintainers: making a release

Every merge to `main` that changes behaviour is a release:

1. Bump `version` in `package.json` and `VERSION` in `src/cli.ts`: minor for a feature, patch for a fix.
2. Add an entry to `CHANGELOG.md` headed `## <version> (<date>)`.
3. Rebuild and stage `dist/src/`, then `npm test`.
4. After the merge, tag it and push the tag: `git tag v<version> && git push origin v<version>`.

The check announces the highest **tag**, so nothing reaches users until step 4, and a commit
on `main` without a tag is never announced. `test/update.test.ts` fails if the two version
fields disagree or the changelog has no entry for the current version.
