import * as vscode from 'vscode';
import { posix } from 'path';
import { Connection } from './connection';
import { IgnoreMatcher } from './sync';

export class RemoteNode {
  constructor(
    public path: string,
    public name: string,
    public readonly isDirectory: boolean,
    public readonly isRoot = false,
  ) {}
}

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly changeEmitter = new vscode.EventEmitter<RemoteNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  // VS Code identifies tree elements by object, so the same instance is reused for a path.
  private nodes = new Map<string, RemoteNode>();

  constructor(
    private readonly conn: Connection,
    private readonly ignore: IgnoreMatcher,
  ) {}

  /** Refreshes a node, or the whole tree. */
  refresh(node?: RemoteNode): void {
    if (!node) this.nodes.clear();
    this.changeEmitter.fire(node?.isDirectory === false ? this.getParent(node) : node);
  }

  /** Refreshes the folder at a remote path, if it is in the tree. */
  refreshPath(remoteDir: string): void {
    const node = this.nodes.get(remoteDir);
    if (node) this.changeEmitter.fire(node);
  }

  getNode(remotePath: string): RemoteNode | undefined {
    return this.nodes.get(remotePath);
  }

  get root(): RemoteNode | undefined {
    return this.conn.config ? this.nodes.get(this.conn.config.remote) : undefined;
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    const state = node.isDirectory
      ? node.isRoot ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.name, state);
    item.id = node.path;
    item.resourceUri = vscode.Uri.from({ scheme: 'remoteftp', path: node.isRoot ? '/' : node.path });
    item.iconPath = node.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    item.contextValue = node.isRoot ? 'rftpRoot' : node.isDirectory ? 'rftpFolder' : 'rftpFile';
    item.tooltip = node.path;
    if (!node.isDirectory) {
      item.command = { command: 'remoteFtp.openFile', title: 'Open', arguments: [node] };
    }
    return item;
  }

  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    const config = this.conn.config;
    if (this.conn.state !== 'connected' || !config) return [];
    if (!node) {
      return [this.intern(new RemoteNode(config.remote, config.remote, true, true))];
    }

    let entries;
    try {
      entries = await this.conn.run(c => c.list(node.path));
    } catch (err) {
      if (this.conn.state === 'connected') {
        vscode.window.showErrorMessage(`Remote FTP: could not list ${node.path}. ${err instanceof Error ? err.message : err}`);
      }
      return [];
    }

    const settings = vscode.workspace.getConfiguration('remoteFtp');
    const showHidden = settings.get<boolean>('showHiddenFiles', true);
    const hideIgnored = settings.get<boolean>('hideIgnoredFiles', true);
    const children: RemoteNode[] = [];
    for (const e of entries) {
      if (!showHidden && e.name.startsWith('.')) continue;
      if (hideIgnored && (await this.ignore.isIgnored(posix.relative(config.remote, e.path), e.isDirectory))) continue;
      children.push(this.intern(new RemoteNode(e.path, e.name, e.isDirectory)));
    }
    return children.sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }

  getParent(node: RemoteNode): RemoteNode | undefined {
    return node.isRoot ? undefined : this.nodes.get(posix.dirname(node.path));
  }

  private intern(node: RemoteNode): RemoteNode {
    const existing = this.nodes.get(node.path);
    if (existing && existing.isDirectory === node.isDirectory && existing.isRoot === node.isRoot) return existing;
    this.nodes.set(node.path, node);
    return node;
  }

  /** Forgets a deleted or renamed path and everything under it. */
  forget(remotePath: string): void {
    for (const p of [...this.nodes.keys()]) {
      if (p === remotePath || p.startsWith(remotePath + '/')) this.nodes.delete(p);
    }
  }
}
