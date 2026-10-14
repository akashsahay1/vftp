import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { posix } from 'path';
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { FtpConfig } from '../config';
import { ClientHooks, RemoteClient, RemoteEntry } from './types';

type Callback<T> = (err: Error | null | undefined, result?: T) => void;

export class SftpClient implements RemoteClient {
  private conn = new Client();
  private sftp?: SFTPWrapper;
  private connected = false;
  private closeListener?: () => void;

  constructor(private cfg: FtpConfig, private hooks: ClientHooks) {}

  connect(): Promise<void> {
    const c = this.cfg;
    const opts: ConnectConfig = {
      host: c.host,
      port: c.port,
      username: c.user,
      readyTimeout: c.connTimeout,
      keepaliveInterval: c.keepalive,
      tryKeyboard: c.keyboardInteractive || c.keyboardInteractiveForPass,
    };
    if (c.pass) opts.password = c.pass;
    if (c.privatekey) {
      opts.privateKey = fs.readFileSync(c.privatekey.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (c.passphrase) opts.passphrase = c.passphrase;
    }
    if (c.agent) opts.agent = c.agent === 'env' ? process.env.SSH_AUTH_SOCK : c.agent;
    if (c.hosthash) (opts as any).hostHash = c.hosthash;
    if (!c.ignorehost) {
      // With hostHash set ssh2 passes a hex string, otherwise the raw key.
      (opts as any).hostVerifier = (key: Buffer | string, verify: (ok: boolean) => void) => {
        const fingerprint = typeof key === 'string'
          ? `${c.hosthash!.toUpperCase()}:${key}`
          : 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        this.hooks.verifyHost(fingerprint).then(verify, () => verify(false));
      };
    }

    this.conn.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
      if (c.keyboardInteractiveForPass) {
        finish(prompts.map(() => c.pass ?? ''));
        return;
      }
      void (async () => {
        const answers: string[] = [];
        for (const p of prompts) {
          const answer = await this.hooks.promptSecret(p.prompt.trim() || instructions || 'Verification code', !p.echo);
          if (answer === undefined) return finish([]);
          answers.push(answer);
        }
        finish(answers);
      })();
    });
    this.conn.on('banner', msg => this.hooks.log(msg.trim()));
    this.conn.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this.closeListener?.();
      }
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      this.conn.on('error', err => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.hooks.log(`Error: ${err.message}`);
        }
      });
      this.conn.once('ready', () => {
        this.hooks.log('Authenticated, opening SFTP session…');
        this.conn.sftp((err, sftp) => {
          settled = true;
          if (err) {
            this.conn.end();
            return reject(err);
          }
          this.sftp = sftp;
          this.connected = true;
          resolve();
        });
      });
      this.conn.connect(opts);
    });
  }

  async end(): Promise<void> {
    this.connected = false;
    this.conn.end();
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) throw new Error('Not connected');
    return this.sftp;
  }

  private call<T = void>(fn: (cb: Callback<T>) => void): Promise<T> {
    return new Promise((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result as T))));
  }

  pwd(): Promise<string> {
    return this.call<string>(cb => this.s.realpath('.', cb));
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = await this.call<any[]>(cb => this.s.readdir(dir, cb));
    const entries: RemoteEntry[] = [];
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue;
      const path = posix.join(dir, item.filename);
      let isDirectory = item.attrs.isDirectory();
      if (item.attrs.isSymbolicLink()) {
        try {
          isDirectory = (await this.call<any>(cb => this.s.stat(path, cb))).isDirectory();
        } catch {
          // Broken link: show it as a file.
        }
      }
      entries.push({ name: item.filename, path, isDirectory, size: item.attrs.size });
    }
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.call(cb => this.s.stat(path, cb as any));
      return true;
    } catch {
      return false;
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.call(cb => this.s.fastGet(remotePath, localPath, cb as any));
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.call(cb => this.s.fastPut(localPath, remotePath, cb as any));
    if (this.cfg.filePermissions) {
      await this.call(cb => this.s.chmod(remotePath, parseInt(this.cfg.filePermissions!, 8), cb as any));
    }
  }

  async createEmptyFile(remotePath: string): Promise<void> {
    await this.call(cb => this.s.writeFile(remotePath, '', cb as any));
  }

  async mkdir(dir: string): Promise<void> {
    if (await this.exists(dir)) return;
    const parent = posix.dirname(dir);
    if (parent !== dir) await this.mkdir(parent);
    await this.call(cb => this.s.mkdir(dir, cb as any));
  }

  async deleteFile(path: string): Promise<void> {
    await this.call(cb => this.s.unlink(path, cb as any));
  }

  async deleteDir(path: string): Promise<void> {
    for (const entry of await this.list(path)) {
      if (entry.isDirectory) await this.deleteDir(entry.path);
      else await this.deleteFile(entry.path);
    }
    await this.call(cb => this.s.rmdir(path, cb as any));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call(cb => this.s.rename(from, to, cb as any));
  }

  async noop(): Promise<void> {
    // ssh2 sends its own keepalive packets.
  }
}
