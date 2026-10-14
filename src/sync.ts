import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import ignore, { Ignore } from 'ignore';
import { CONFIG_FILE, IGNORE_FILE } from './config';
import { Connection } from './connection';
import { RemoteClient } from './remote/types';

/** .ftpignore matcher, reloaded when the file changes. */
export class IgnoreMatcher {
  private matcher?: Ignore;

  constructor(private readonly root: vscode.Uri) {}

  reset(): void {
    this.matcher = undefined;
  }

  private async load(): Promise<Ignore> {
    if (!this.matcher) {
      const ig = ignore().add(CONFIG_FILE);
      try {
        ig.add(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, IGNORE_FILE))).toString('utf8'));
      } catch {
        // No .ftpignore.
      }
      this.matcher = ig;
    }
    return this.matcher;
  }

  /** `rel` is a project-relative path using forward slashes. */
  async isIgnored(rel: string, isDirectory: boolean): Promise<boolean> {
    if (!rel || rel === '.' || rel.startsWith('..')) return false;
    return (await this.load()).ignores(isDirectory ? rel + '/' : rel);
  }
}

/**
 * Remembers local files the extension just wrote or uploaded, so the
 * save handler and the file watchers don't upload them again.
 */
export class LocalWriteGuard {
  private until = new Map<string, number>();

  mark(fsPath: string, ms = 3000): void {
    this.until.set(key(fsPath), Date.now() + ms);
  }

  isMarked(fsPath: string): boolean {
    const t = this.until.get(key(fsPath));
    if (t === undefined) return false;
    if (t < Date.now()) {
      this.until.delete(key(fsPath));
      return false;
    }
    return true;
  }
}

const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

export class Sync {
  constructor(
    private readonly conn: Connection,
    private readonly ignore: IgnoreMatcher,
    readonly guard: LocalWriteGuard,
  ) {}

  private rel(localPath: string): string {
    return path.relative(this.conn.root.fsPath, localPath).split(path.sep).join('/');
  }

  /** Uploads a project file or folder to its matching remote path. Returns the number of files uploaded. */
  upload(localPath: string): Promise<number> {
    const remotePath = this.conn.toRemote(localPath);
    if (!remotePath) return Promise.reject(new Error(`${localPath} is outside the project folder.`));
    return this.conn.run(client => this.uploadWith(client, localPath, remotePath));
  }

  /** Uploads any local file or folder into a remote folder, keeping its name. */
  uploadInto(localPath: string, remoteDir: string): Promise<number> {
    return this.conn.run(client => this.uploadWith(client, localPath, posix.join(remoteDir, path.basename(localPath))));
  }

  private async uploadWith(client: RemoteClient, localPath: string, remotePath: string): Promise<number> {
    const stat = await fs.promises.stat(localPath);
    // .ftpignore patterns are matched against the path below the remote root.
    const rel = this.conn.config ? posix.relative(this.conn.config.remote, remotePath) : '';
    if (await this.ignore.isIgnored(rel, stat.isDirectory())) return 0;

    if (stat.isDirectory()) {
      await client.mkdir(remotePath);
      let count = 0;
      for (const name of await fs.promises.readdir(localPath)) {
        count += await this.uploadWith(client, path.join(localPath, name), posix.join(remotePath, name));
      }
      return count;
    }
    await client.mkdir(posix.dirname(remotePath));
    this.conn.log(`Uploading ${remotePath}`);
    await client.upload(localPath, remotePath);
    return 1;
  }

  /** Downloads a file or folder into the matching project path. Returns the number of files downloaded. */
  download(remotePath: string, isDirectory: boolean): Promise<number> {
    return this.conn.run(client => this.downloadWith(client, remotePath, isDirectory));
  }

  private async downloadWith(client: RemoteClient, remotePath: string, isDirectory: boolean): Promise<number> {
    const localPath = this.conn.toLocal(remotePath);
    if (!localPath) throw new Error(`${remotePath} is outside the remote folder.`);
    if (await this.ignore.isIgnored(this.rel(localPath), isDirectory)) return 0;

    if (isDirectory) {
      await fs.promises.mkdir(localPath, { recursive: true });
      let count = 0;
      for (const entry of await client.list(remotePath)) {
        count += await this.downloadWith(client, entry.path, entry.isDirectory);
      }
      return count;
    }
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    this.guard.mark(localPath);
    this.conn.log(`Downloading ${remotePath}`);
    await client.download(remotePath, localPath);
    this.guard.mark(localPath);
    return 1;
  }
}
