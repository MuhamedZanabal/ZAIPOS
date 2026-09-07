# Required `main` protection

The connected repository integration cannot administer branch protection. GitHub reports `main.protected=false`, no repository rulesets, and HTTP 403 `Resource not accessible by integration` for the branch-protection endpoint.

The repository owner must create a branch ruleset targeting `main` with these controls:

- require a pull request before merging;
- require at least one approving review and dismissal of stale approvals after new commits;
- require resolution of all review conversations;
- require status checks `quality` and `windows-package` to pass;
- require the branch to be up to date before merge;
- block force pushes;
- block branch deletion;
- restrict direct updates to designated repository administrators or release automation;
- do not allow bypass except a documented emergency administrator path.

After enabling the ruleset, verify it by attempting a non-destructive direct update from a non-bypass account and by confirming a red required check blocks a test PR merge.
