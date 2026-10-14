import { posix } from 'path';
import { Readable } from 'stream';
import { Client } from 'basic-ftp';
import { FtpConfig } from '../config';
import { ClientHooks, RemoteClient, RemoteEntry } from './types';

export class FtpClient implements RemoteClient {
  private client: Client;
  private connected = false;
  private closeListener?: () => void;

  constructor(private cfg: FtpConfig, private hooks: ClientHooks) {
    this.client = new Client(Math.max(cfg.connTimeout, cfg.pasvTimeout));
    this.client.ftp.verbose = true;
    this.client.ftp.log = (message: string) => {
      // Don't echo the password into the log.
      this.hooks.log(message.replace(/^(> PASS ).*/m, '$1********'));
    };
  }

  async connect(): Promise<void> {
    const c = this.cfg;
    // basic-ftp always encrypts the data connection too when "secure" is on, so "control" behaves like true.
    const secure = c.secure === 'implicit' ? 'implicit' : !!c.secure;
    await this.client.access({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.pass,
      secure,
      secureOptions: c.secureOptions as any,
    });
    this.connected = true;
  }

  async end(): Promise<void> {
    this.connected = false;
    this.client.close();
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  /** Runs an operation and reports a dropped connection. */
  private async op<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.connected && this.client.closed) {
        this.connected = false;
        this.closeListener?.();
      }
      throw err;
    }
  }

  pwd(): Promise<string> {
    return this.op(async () => (await this.client.pwd()).replace(/\\/g, '/'));
  }

  list(dir: string): Promise<RemoteEntry[]> {
    return this.op(async () => {
      const items = await this.client.list(dir);
      const entries: RemoteEntry[] = [];
      for (const item of items) {
        if (item.name === '.' || item.name === '..') continue;
        const path = posix.join(dir, item.name);
        let isDirectory = item.isDirectory;
        if (item.isSymbolicLink) {
          try {
            await this.client.cd(path);
            isDirectory = true;
          } catch {
            isDirectory = false;
          }
        }
        entries.push({ name: item.name, path, isDirectory, size: item.size });
      }
      return entries;
    });
  }

  async exists(path: string): Promise<boolean> {
    const parent = posix.dirname(path);
    if (parent === path) return true;
    try {
      const items = await this.op(() => this.client.list(parent));
      return items.some(i => i.name === posix.basename(path));
    } catch {
      return false;
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.op(() => this.client.downloadTo(localPath, remotePath));
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.op(() => this.client.uploadFrom(localPath, remotePath));
  }

  async createEmptyFile(remotePath: string): Promise<void> {
    await this.op(() => this.client.uploadFrom(Readable.from([]), remotePath));
  }

  async mkdir(dir: string): Promise<void> {
    // ensureDir creates missing parents and changes the working directory; all other calls use absolute paths.
    await this.op(() => this.client.ensureDir(dir));
  }

  async deleteFile(path: string): Promise<void> {
    await this.op(() => this.client.remove(path));
  }

  async deleteDir(path: string): Promise<void> {
    await this.op(() => this.client.removeDir(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.op(() => this.client.rename(from, to));
  }

  async noop(): Promise<void> {
    await this.op(() => this.client.send('NOOP'));
  }
}
