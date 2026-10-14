import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { CONFIG_FILE, FTP_TEMPLATE, IGNORE_FILE, IGNORE_TEMPLATE, SFTP_TEMPLATE } from './config';
import { Connection, ConnectionState } from './connection';
import { IgnoreMatcher, LocalWriteGuard, Sync } from './sync';
import { RemoteNode, RemoteTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const output = vscode.window.createOutputChannel('Remote FTP');
  context.subscriptions.push(output);

  const runCommand = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[${new Date().toLocaleTimeString()}] Error: ${message}`);
      vscode.window.showErrorMessage(`Remote FTP: ${message}`);
    }
  };
  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: any[]) => runCommand(() => fn(...args))));

  if (!folder) {
    const needFolder = () => vscode.window.showInformationMessage('Remote FTP: open a folder first (File → Open Folder…).');
    for (const id of ['createFtpConfig', 'createSftpConfig', 'createIgnoreFile', 'connect', 'toggle']) {
      register(`remoteFtp.${id}`, needFolder);
    }
    return;
  }

  const root = folder.uri;
  const conn = new Connection(root, output, context);
  const ignore = new IgnoreMatcher(root);
  const guard = new LocalWriteGuard();
  const sync = new Sync(conn, ignore, guard);
  const tree = new RemoteTreeProvider(conn, ignore);
  const view = vscode.window.createTreeView('remoteFtp.explorer', {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: {
      dragMimeTypes: [],
      dropMimeTypes: ['text/uri-list', 'files'],
      handleDrop: (target, dataTransfer) => runCommand(() => uploadDropped(target, dataTransfer)),
    },
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'remoteFtp.toggle';
  context.subscriptions.push(conn, view, status);

  const configUri = vscode.Uri.joinPath(root, CONFIG_FILE);
  const ignoreUri = vscode.Uri.joinPath(root, IGNORE_FILE);
  let hasConfig = false;

  const updateConfigState = async () => {
    hasConfig = await exists(configUri);
    await vscode.commands.executeCommand('setContext', 'remoteFtp.hasConfig', hasConfig);
    updateStatus();
  };

  const updateStatus = () => {
    const host = conn.config?.host;
    if (conn.state === 'connected') {
      status.text = `$(cloud) ${host}`;
      status.tooltip = `Remote FTP: connected to ${conn.config?.protocol}://${host}${conn.config?.remote}`;
    } else if (conn.state === 'connecting') {
      status.text = '$(sync~spin) FTP: connecting…';
      status.tooltip = 'Remote FTP: connecting';
    } else {
      status.text = '$(debug-disconnect) FTP';
      status.tooltip = 'Remote FTP: not connected';
    }
    if (hasConfig) status.show();
    else status.hide();
  };

  // Uploads files listed in "watch" when they change outside the editor.
  let watchers: vscode.Disposable[] = [];
  const stopWatchers = () => {
    watchers.forEach(w => w.dispose());
    watchers = [];
  };
  const startWatchers = () => {
    stopWatchers();
    const cfg = conn.config;
    if (!cfg?.watch.length) return;
    const timers = new Map<string, NodeJS.Timeout>();
    for (const entry of cfg.watch) {
      let pattern = entry.replace(/\\/g, '/').replace(/^\.?\//, '');
      if (pattern.endsWith('/')) pattern += '**';
      else if (!/[*?[{]/.test(pattern) && fs.existsSync(path.join(root.fsPath, pattern)) && fs.statSync(path.join(root.fsPath, pattern)).isDirectory()) {
        pattern += '/**';
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern), false, false, true);
      const onChange = (uri: vscode.Uri) => {
        clearTimeout(timers.get(uri.fsPath));
        timers.set(uri.fsPath, setTimeout(() => {
          timers.delete(uri.fsPath);
          if (guard.isMarked(uri.fsPath) || conn.state !== 'connected') return;
          uploadQuietly(uri.fsPath);
        }, cfg.watchTimeout));
      };
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watchers.push(watcher);
    }
    conn.log(`Watching: ${cfg.watch.join(', ')}`);
  };
  context.subscriptions.push({ dispose: stopWatchers });

  conn.onDidChangeState(async (state: ConnectionState) => {
    await vscode.commands.executeCommand('setContext', 'remoteFtp.connected', state === 'connected');
    await vscode.commands.executeCommand('setContext', 'remoteFtp.connecting', state === 'connecting');
    updateStatus();
    tree.refresh();
    if (state === 'connected') startWatchers();
    else stopWatchers();
  });

  const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, CONFIG_FILE));
  configWatcher.onDidCreate(updateConfigState);
  configWatcher.onDidDelete(updateConfigState);
  configWatcher.onDidChange(() => {
    if (conn.state === 'connected') {
      vscode.window.showInformationMessage('Remote FTP: .ftpconfig changed. Reconnect to apply it.', 'Reconnect').then(async choice => {
        if (choice === 'Reconnect') {
          await conn.disconnect();
          await conn.connect();
        }
      });
    }
  });
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, IGNORE_FILE));
  const reloadIgnore = () => {
    ignore.reset();
    if (conn.state === 'connected') tree.refresh();
  };
  ignoreWatcher.onDidCreate(reloadIgnore);
  ignoreWatcher.onDidChange(reloadIgnore);
  ignoreWatcher.onDidDelete(reloadIgnore);
  context.subscriptions.push(configWatcher, ignoreWatcher);

  // ---- helpers ----

  const ensureConnected = async () => {
    if (conn.state === 'connected') return true;
    if (!hasConfig) {
      vscode.window.showWarningMessage('Remote FTP: create a config file first.', 'Create FTP Config', 'Create SFTP Config').then(choice => {
        if (choice === 'Create FTP Config') vscode.commands.executeCommand('remoteFtp.createFtpConfig');
        if (choice === 'Create SFTP Config') vscode.commands.executeCommand('remoteFtp.createSftpConfig');
      });
      return false;
    }
    return conn.connect();
  };

  const uploadQuietly = async (fsPath: string) => {
    try {
      guard.mark(fsPath);
      const count = await sync.upload(fsPath);
      if (count) {
        vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${path.basename(fsPath)}`, 3000);
        const remote = conn.toRemote(fsPath);
        if (remote) tree.refreshPath(posix.dirname(remote));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      conn.log(`Upload failed: ${message}`);
      vscode.window.showErrorMessage(`Remote FTP: upload of ${path.basename(fsPath)} failed. ${message}`);
    }
  };

  /** The folder a new file/folder goes into: the clicked folder, the clicked file's folder, the selection, or the root. */
  const targetDir = (node?: RemoteNode): RemoteNode | undefined => {
    const n = node ?? view.selection[0] ?? tree.root;
    if (!n) return undefined;
    return n.isDirectory ? n : tree.getParent(n) ?? tree.root;
  };

  /**
   * The items a context-menu command acts on: the whole selection when the clicked item is part of it,
   * otherwise just the clicked item. Items inside another selected folder are dropped, since the folder covers them.
   */
  const selectedNodes = (node?: RemoteNode, nodes?: RemoteNode[], include: (n: RemoteNode) => boolean = () => true): RemoteNode[] => {
    const list = (node ? (nodes?.includes(node) ? nodes : [node]) : [...view.selection]).filter(include);
    const isInside = (child: RemoteNode, dir: RemoteNode) =>
      dir !== child && dir.isDirectory && child.path.startsWith(dir.path.endsWith('/') ? dir.path : dir.path + '/');
    return list.filter(n => !list.some(other => isInside(n, other)));
  };

  const askName =(prompt: string, value = '') =>
    vscode.window.showInputBox({
      title: 'Remote FTP',
      prompt,
      value,
      valueSelection: value ? [0, value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length] : undefined,
      validateInput: v => {
        if (!v.trim()) return 'Enter a name.';
        if (v.includes('\\') || v.split('/').some(part => part === '..')) return 'Use forward slashes and no "..".';
        return undefined;
      },
    });

  const openRemoteFile = async (node: RemoteNode) => {
    const localPath = conn.toLocal(node.path);
    if (!localPath) throw new Error(`${node.path} is outside the remote folder.`);
    const uri = vscode.Uri.file(localPath);
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === localPath.toLowerCase());
    if (!openDoc?.isDirty) {
      await vscode.window.withProgress(
        { location: { viewId: 'remoteFtp.explorer' } },
        () => sync.download(node.path, false),
      );
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  };

  const withNotification = <T>(title: string, task: () => Promise<T>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

  /** Uploads files and folders dropped from VS Code's Explorer or the operating system into a remote folder. */
  const uploadDropped = async (target: RemoteNode | undefined, dataTransfer: vscode.DataTransfer) => {
    const uris: vscode.Uri[] = [];
    const uriList = dataTransfer.get('text/uri-list');
    if (uriList) {
      for (const line of (await uriList.asString()).split(/\r?\n/)) {
        if (line.trim() && !line.startsWith('#')) uris.push(vscode.Uri.parse(line.trim()));
      }
    } else {
      dataTransfer.forEach(item => {
        const uri = item.asFile()?.uri;
        if (uri) uris.push(uri);
      });
    }
    const paths = [...new Set(uris.filter(u => u.scheme === 'file').map(u => u.fsPath))];
    if (!paths.length) return;
    if (conn.state !== 'connected') {
      vscode.window.showInformationMessage('Remote FTP: connect before dropping files to upload.');
      return;
    }

    const dir = targetDir(target ?? tree.root);
    if (!dir) return;
    const existing = await conn.run(async c => {
      const found: string[] = [];
      for (const p of paths) {
        if (await c.exists(posix.join(dir.path, path.basename(p)))) found.push(path.basename(p));
      }
      return found;
    });
    if (existing.length) {
      const choice = await vscode.window.showWarningMessage(
        existing.length === 1 ? `"${existing[0]}" already exists in ${dir.path}. Replace it?` : `${existing.length} items already exist in ${dir.path}. Replace them?`,
        { modal: true, detail: existing.length > 1 ? existing.join('\n') : undefined },
        'Replace',
      );
      if (choice !== 'Replace') return;
    }

    let count = 0;
    await withNotification(`Uploading to ${dir.path}…`, async () => {
      for (const p of paths) count += await sync.uploadInto(p, dir.path);
    });
    tree.refresh(dir);
    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${count} file${count === 1 ? '' : 's'} to ${dir.path}`, 4000);
  };

  // ---- commands ----

  register('remoteFtp.toggle', async () => {
    if (view.visible) await vscode.commands.executeCommand('workbench.action.closeSidebar');
    else await vscode.commands.executeCommand('workbench.view.extension.remoteFtp');
  });

  const createConfig = async (template: string) => {
    if (await exists(configUri)) {
      const choice = await vscode.window.showWarningMessage(`${CONFIG_FILE} already exists.`, 'Open It', 'Overwrite');
      if (choice === 'Overwrite') await vscode.workspace.fs.writeFile(configUri, Buffer.from(template, 'utf8'));
      else if (choice !== 'Open It') return;
    } else {
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(template, 'utf8'));
    }
    await updateConfigState();
    await vscode.window.showTextDocument(configUri);
  };
  register('remoteFtp.createFtpConfig', () => createConfig(FTP_TEMPLATE));
  register('remoteFtp.createSftpConfig', () => createConfig(SFTP_TEMPLATE));

  register('remoteFtp.createIgnoreFile', async () => {
    if (!(await exists(ignoreUri))) await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(IGNORE_TEMPLATE, 'utf8'));
    await vscode.window.showTextDocument(ignoreUri);
  });

  register('remoteFtp.editConfig', () => vscode.window.showTextDocument(configUri));

  register('remoteFtp.connect', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.remoteFtp');
    await ensureConnected();
  });

  register('remoteFtp.disconnect', () => conn.disconnect());

  register('remoteFtp.refresh', (node?: RemoteNode) => tree.refresh(node));

  register('remoteFtp.openFile', async (node: RemoteNode) => {
    if (node && !node.isDirectory) await openRemoteFile(node);
  });

  register('remoteFtp.addFile', async (node?: RemoteNode) => {
    const dir = targetDir(node);
    if (!dir) return;
    const name = await askName(`New file in ${dir.path}`);
    if (!name) return;
    const remotePath = posix.join(dir.path, name.trim());
    await conn.run(async c => {
      if (await c.exists(remotePath)) throw new Error(`${remotePath} already exists.`);
      await c.mkdir(posix.dirname(remotePath));
      await c.createEmptyFile(remotePath);
    });
    conn.log(`Created ${remotePath}`);
    tree.refresh(dir);
    await openRemoteFile(new RemoteNode(remotePath, posix.basename(remotePath), false));
  });

  register('remoteFtp.addFolder', async (node?: RemoteNode) => {
    const dir = targetDir(node);
    if (!dir) return;
    const name = await askName(`New folder in ${dir.path}`);
    if (!name) return;
    const remotePath = posix.join(dir.path, name.trim());
    await conn.run(async c => {
      if (await c.exists(remotePath)) throw new Error(`${remotePath} already exists.`);
      await c.mkdir(remotePath);
    });
    conn.log(`Created folder ${remotePath}`);
    tree.refresh(dir);
  });

  register('remoteFtp.rename', async (node?: RemoteNode) => {
    node ??= view.selection[0];
    if (!node || node.isRoot) return;
    const name = await askName(`Rename ${node.path}`, node.name);
    if (!name || name.trim() === node.name) return;
    const parent = tree.getParent(node);
    const newPath = posix.join(posix.dirname(node.path), name.trim());
    await conn.run(async c => {
      if (await c.exists(newPath)) throw new Error(`${newPath} already exists.`);
      await c.rename(node!.path, newPath);
    });
    conn.log(`Renamed ${node.path} → ${newPath}`);
    tree.forget(node.path);
    tree.refresh(parent);
  });

  register('remoteFtp.delete', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
    const targets = selectedNodes(node, nodes, n => !n.isRoot);
    if (!targets.length) return;
    const only = targets[0];
    const message = targets.length === 1
      ? `Delete ${only.isDirectory ? `the folder "${only.name}" and everything in it` : `"${only.name}"`} from the server?`
      : `Delete ${targets.length} items from the server?`;
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: `${targets.map(n => n.path + (n.isDirectory ? '/' : '')).join('\n')}\n\nThis cannot be undone. Your local copies are not touched.` },
      'Delete',
    );
    if (choice !== 'Delete') return;

    const parents = new Set(targets.map(n => tree.getParent(n)));
    try {
      await withNotification(targets.length === 1 ? `Deleting ${only.name}…` : `Deleting ${targets.length} items…`, async () => {
        for (const n of targets) {
          await conn.run(c => (n.isDirectory ? c.deleteDir(n.path) : c.deleteFile(n.path)));
          conn.log(`Deleted ${n.path}`);
          tree.forget(n.path);
        }
      });
    } finally {
      parents.forEach(p => tree.refresh(p));
    }
  });

  register('remoteFtp.download', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
    const targets = selectedNodes(node, nodes);
    if (!targets.length) return;
    let count = 0;
    await withNotification(targets.length === 1 ? `Downloading ${targets[0].name}…` : `Downloading ${targets.length} items…`, async () => {
      for (const n of targets) count += await sync.download(n.path, n.isDirectory);
    });
    vscode.window.setStatusBarMessage(`$(cloud-download) Downloaded ${count} file${count === 1 ? '' : 's'}`, 4000);
  });

  register('remoteFtp.upload', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    let targets = uris?.length ? uris : uri ? [uri] : [];
    if (!targets.length) {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('Remote FTP: open a file or select files in the Explorer to upload.');
        return;
      }
      if (doc.isDirty) {
        guard.mark(doc.uri.fsPath);
        await doc.save();
      }
      targets = [doc.uri];
    }
    if (!(await ensureConnected())) return;
    let count = 0;
    await withNotification('Uploading…', async () => {
      for (const t of targets) {
        guard.mark(t.fsPath);
        count += await sync.upload(t.fsPath);
        const remote = conn.toRemote(t.fsPath);
        if (remote) tree.refreshPath(posix.dirname(remote));
      }
    });
    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded ${count} file${count === 1 ? '' : 's'}`, 4000);
  });

  register('remoteFtp.downloadLocal', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const targets = uris?.length ? uris : uri ? [uri] : [];
    if (!targets.length || !(await ensureConnected())) return;
    let count = 0;
    await withNotification('Downloading…', async () => {
      for (const t of targets) {
        const remote = conn.toRemote(t.fsPath);
        if (!remote) continue;
        const isDirectory = (await fs.promises.stat(t.fsPath)).isDirectory();
        count += await sync.download(remote, isDirectory);
      }
    });
    vscode.window.setStatusBarMessage(`$(cloud-download) Downloaded ${count} file${count === 1 ? '' : 's'}`, 4000);
  });

  // ---- upload on save ----

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async doc => {
    if (doc.uri.scheme !== 'file' || !hasConfig) return;
    const mode = vscode.workspace.getConfiguration('remoteFtp').get<string>('autoUploadOnSave', 'always');
    if (mode === 'never') return;
    const rel = path.relative(root.fsPath, doc.uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (guard.isMarked(doc.uri.fsPath)) return;
    if (await ignore.isIgnored(rel.split(path.sep).join('/'), false)) return;
    if (conn.state !== 'connected') {
      if (mode !== 'always' || !(await conn.connect())) return;
    }
    await uploadQuietly(doc.uri.fsPath);
  }));

  // ---- startup ----

  void updateConfigState().then(async () => {
    await vscode.commands.executeCommand('setContext', 'remoteFtp.connected', false);
    if (hasConfig && vscode.workspace.getConfiguration('remoteFtp').get<boolean>('connectOnStartup', false)) {
      await conn.connect();
    }
  });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function deactivate(): void {}
