/*
 * The file tree, a role=tree list like GitHub's, with single-folder chains folded into one row as GitHub does. The panel marks its
 * rows itself (hidden), so they take no props of that name.
 */
import { html, useMemo } from '/assets/preact.mjs';
import { baseName } from '/assets/terms/text.ts';
import { gotoFile } from '/assets/local/actions.ts';
import { usage } from '/assets/local/page.ts';

/** A folder in the file tree. */
interface TreeNode {
  name?: string;
  dirs: Map<string, TreeNode>;
  files: string[];
}

// the indent is computed from the depth, so it stays an inline style
const indent = (depth: number) => `padding-left:${8 + depth * 12}px`;

function draw(node: TreeNode, depth: number): unknown[] {
  const dirs = [...node.dirs].sort().map(([key, dir]) => {
    let folderKey = key;
    let folder = dir;
    let label = dir.name as string;
    while (folder.files.length === 0 && folder.dirs.size === 1) {
      const [nextKey, nextFolder] = [...folder.dirs][0];
      folderKey = nextKey;
      label += '/' + nextFolder.name;
      folder = nextFolder;
    }
    return html`<div key=${folderKey} role="treeitem" aria-expanded="true" id=${folderKey} class="ou-local-tree-dir"><div class="ou-local-tree-label" style=${indent(depth)}>${label}</div><div role="group">${draw(folder, depth + 1)}</div></div>`;
  });
  const files = node.files.sort().map(
    (rel) =>
      html`<div key=${rel} role="treeitem" id=${rel} class="ou-local-tree-file" data-goto=${rel} style=${indent(depth)} onClick=${() => {
        usage.count('local.tree.goto');
        gotoFile(rel);
      }}>${baseName(rel)}</div>`,
  );
  return [dirs, files];
}

export function FileTree(props: { rels: string[] }) {
  const key = props.rels.join('\n');
  const tree = useMemo(() => {
    const root: TreeNode = { dirs: new Map(), files: [] };
    for (const rel of props.rels) {
      const parts = rel.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dirKey = parts.slice(0, i + 1).join('/');
        if (!node.dirs.has(dirKey)) {
          node.dirs.set(dirKey, { name: parts[i], dirs: new Map(), files: [] });
        }
        node = node.dirs.get(dirKey) as TreeNode;
      }
      node.files.push(rel);
    }
    return draw(root, 0);
  }, [key]);
  return html`<nav class="ou-local-tree" role="tree" aria-label="Changed files">${tree}</nav>`;
}
