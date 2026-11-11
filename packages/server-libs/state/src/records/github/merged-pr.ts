/** The read-only GraphQL check that lands a card: the PR for a branch that merged into the repo's default branch (ghMergedCheck). */
import { ghGraphql } from '@once-upon-a-diff/foundation/gh';

/** A merged PR: its number, the commit it made on the base branch (the merge, the squash or the last rebased commit), when it merged and into what. */
export interface MergedPr {
  number: number;
  merge_oid: string;
  merged_at: string;
  base: string;
}
/** The merged PR a branch has, or null. Rejects when GitHub can't be asked. */
export type MergedCheck = (repo: string, branch: string) => Promise<MergedPr | null>;

interface Node {
  number: number;
  mergedAt: string | null;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  headRepository: { nameWithOwner: string } | null;
}

// newest first, so the 20 are the latest PRs for the name, which is the one that counts
const MERGED_QUERY = `query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    nameWithOwner defaultBranchRef{name}
    pullRequests(headRefName:$branch,first:20,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number mergedAt baseRefName mergeCommit{oid} headRepository{nameWithOwner}}}}}`;

/**
 * The real check: `gh api graphql`. A PR counts when its head is in this repo (a fork's branch of the same name is someone
 * else's work; the repo is the name GitHub answers with, since a renamed or transferred repo still answers its old name) and it merged into the repo's default branch (a stacked PR merged into another branch has not shipped the
 * card). The newest by merge time wins. A merge, a squash and a rebase all answer with the commit they made on the base.
 */
export const ghMergedCheck: MergedCheck = async (repo, branch) => {
  const [owner, name] = repo.split('/');
  const out = await ghGraphql<{
    data?: {
      repository: {
        nameWithOwner: string;
        defaultBranchRef: { name: string } | null;
        pullRequests: { nodes: Node[] };
      } | null;
    };
    errors?: { message: string }[];
  }>(MERGED_QUERY, { owner, name, branch }, { timeout: 30000 });
  const found = out.data?.repository;
  if (out.errors?.length || !found) {
    throw new Error(out.errors?.map((e) => e.message).join('; ') || 'no such repo');
  }
  const base = found.defaultBranchRef?.name;
  const home = (found.nameWithOwner || repo).toLowerCase();
  const best = found.pullRequests.nodes
    .filter(
      (node) =>
        node.headRepository?.nameWithOwner.toLowerCase() === home &&
        node.baseRefName === base &&
        node.mergedAt &&
        node.mergeCommit?.oid,
    )
    .sort((first, second) =>
      (second.mergedAt as string).localeCompare(first.mergedAt as string),
    )[0];
  return best
    ? {
        number: best.number,
        merge_oid: (best.mergeCommit as { oid: string }).oid,
        merged_at: best.mergedAt as string,
        base: best.baseRefName,
      }
    : null;
};
