# ADR-08: Stacked local branches reviewed as stories before PRs

Descriptive, of the code on main at 0741c6c (10/29). This one describes a practice as much as code: the branch stack these notes were first written from was reviewed this way.

## Context

Agents write large changes on local branches. The reviewer wants to read each change as a story, ask questions and send fixes before anything is pushed, and to split a big change into a stack of branches that each become a PR.

## Decision

- **A local story per branch:** `once-upon local --repo <worktree> --base <previous branch> [--head <ref>] --chapters <file>` builds `git diff base head` into `<worktree>/.once-upon/local-<folder>-<branch>/` and serves it at `/local/<id>/`. The page draws the diff in GitHub's DOM shapes, so the same panel runs on it (ADR-12).
- **What `--head` means.** With `--head HEAD`, the default and what the skill's first build passes, the story follows whatever the worktree has checked out (`refreshLocal`). With any other ref (a branch, a sha) the story is pinned to the base and head commits it was told over (`base_oid`, `head_oid`). A branch that moves after that shows as moved since, and telling the story again pins the new tips. A story told over a sha records the local branch whose tip it is, and one told over a branch name records that branch.
- **Review happens before push.** You get Viewed marks kept by the bridge, line notes that become Fix before push requests to the listening session (one commit, never a push), Ask, Rebuild and "changed since viewed" when the branch moves.
- **Approve, then ship one of two ways.** Approve says the story is ready at its current head (`approved.json`, an `approved` inbox line, the story marked reviewed). A new commit clears it. What the page offers next depends on the repo (`ship` rules in `config.json`, else the branch):
  - **A pull request.** The skill hands over a PR title and body (`once-upon pr-draft`). Create pull request runs `git push -u origin <branch>` (never forced, refused if the remote has diverged), then opens GitHub's compare page. Nothing runs `gh pr create`. With an open PR, Push sends commits made since with a plain fast-forward `git push`, and the header shows Open PR #N.
  - **The default branch.** For a repo that keeps its notes or config on master, Push sends the approved commit, and no further, as one fast-forward of the default branch. It won't go when the remote has commits this checkout doesn't, and when GitHub protects the branch or requires pull requests it offers Create pull request instead (a protection answer `gh` can't give counts as protected).

  Both pushes are the full story key's alone (ADR-02) and run from the reviewer's click in a confirm box.
- **The board lists local stories** on their branch's card, in Ready for your review or Back to you, and in Ready to ship once approved (ADR-07).
- **The code doesn't know about stacks.** A story's base is a ref string, and no story knows its parent or children. The stack exists only as branch names and the order they were made in.

## Consequences

- Review comes before the code leaves the machine, which matches the "no PR before a story review" rule.
- **A story told over `HEAD` follows HEAD, not its branch.** `meta.branch` is stored but never checked on refresh. Restacking in one worktree, checking out each branch in turn, quietly changes what an older branch's story shows. Pinned stories don't drift, but the skill's first build and the README's example pass `--head HEAD`, so that's the common case.
- **Ids depend on the worktree folder:** the same branch `feature` from worktree folders `a/` and `b/` is two stories (`local-a-feature`, `local-b-feature`). Reviewed, read, viewed and notes state doesn't carry over.
- **A restack moves the base.** A story over HEAD remakes its diff and Viewed marks reset by file hash. A pinned story keeps its commits until it is told again. Reads stay and are compared by commit. Nothing says "this is the same change, rebased".
- When the branch becomes a PR, its PR story (if built) is a different story with its own id and state. The local story's reviews, notes and reads don't move over, and the board shows whichever it finds for the branch.
- Deleting the worktree after merge removes the story and leaves its state behind (ADR-03).

## Open questions

1. Should the skill pass the branch name rather than `HEAD`, or `refreshLocal` check `meta.branch`, so a story is pinned by default and can't drift onto another branch?
2. Should a story id come from repo and branch rather than the worktree folder?
3. Should stacks be modelled, as a parent story id or a stack name in `meta.json`, so the board shows them in order and a restack can carry state forward?
4. When the branch's PR opens, should its local story's state (reviewed, notes, reads) link to the PR story?
5. Should Push to the default branch and Create pull request, which both run `git push` from the bridge, ask for the token rather than the story key, given that the story key is in a link (ADR-02)?
