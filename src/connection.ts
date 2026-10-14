import * as vscode from 'vscode';
import * as path from 'path';
import { posix } from 'path';
import { FtpConfig, readConfig } from './config';
import { FtpClient } from './remote/ftpClient';
import { SftpClient } from './remote/sftpClient';
import { ClientHooks, RemoteClient } from './remote/types';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const KNOWN_HOSTS_KEY = 'remoteFtp.knownHosts';

export class Connection implements vscode.Disposable {
  state: ConnectionState = 'disconnected';
  config?: FtpConfig;
  private client?: RemoteClient;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private keepaliveTimer?: NodeJS.Timeout;
  private connecting?: Promise<boolean>;

  private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    readonly root: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext,
  ) {}

  log(message: string): void {
    const time = new Date().toLocaleTimeString();
    for (const line of message.split(/\r?\n/)) {
      if (line) this.output.appendLine(`[${time}] ${line}`);
    }
  }

  connect(): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<boolean> {
    this.setState('connecting');
    try {
      const cfg = await readConfig(this.root);
      if (cfg.promptForPass) {
        const isPassphrase = cfg.protocol === 'sftp' && !!cfg.privatekey;
        const secret = await vscode.window.showInputBox({
          title: 'Remote FTP',
          prompt: isPassphrase ? `Passphrase for ${cfg.privatekey}` : `Password for ${cfg.user}@${cfg.host}`,
          password: true,
          ignoreFocusOut: true,
        });
        if (secret === undefined) {
          this.setState('disconnected');
          return false;
        }
        if (isPassphrase) cfg.passphrase = secret;
        else cfg.pass = secret;
      }

      const client = cfg.protocol === 'sftp' ? new SftpClient(cfg, this.hooks(cfg)) : new FtpClient(cfg, this.hooks(cfg));
      this.log(`Connecting to ${cfg.protocol}://${cfg.host}:${cfg.port} …`);
      await client.connect();
      if (!cfg.remote.startsWith('/')) cfg.remote = posix.join(await client.pwd(), cfg.remote);
      client.onClose(() => this.handleClosed());

      this.client = client;
      this.config = cfg;
      this.queue = Promise.resolve();
      this.pending = 0;
      this.startKeepalive(cfg);
      this.log(`Connected. Remote folder: ${cfg.remote}`);
      this.setState('connected');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Connection failed: ${message}`);
      this.setState('disconnected');
      vscode.window.showErrorMessage(`Remote FTP: could not connect. ${message}`, 'Edit Config', 'Show Log').then(choice => {
        if (choice === 'Edit Config') vscode.commands.executeCommand('remoteFtp.editConfig');
        if (choice === 'Show Log') this.output.show(true);
      });
      return false;
    }
  }

  private hooks(cfg: FtpConfig): ClientHooks {
    return {
      log: line => this.log(line),
      promptSecret: (prompt, password) =>
        Promise.resolve(vscode.window.showInputBox({ title: `Remote FTP: ${cfg.host}`, prompt, password, ignoreFocusOut: true })),
      verifyHost: async fingerprint => {
        const key = `${cfg.host}:${cfg.port}`;
        const known = this.context.globalState.get<Record<string, string>>(KNOWN_HOSTS_KEY, {});
        if (known[key] === fingerprint) return true;
        const message = known[key]
          ? `WARNING: the host key for ${key} has CHANGED.\nOld: ${known[key]}\nNew: ${fingerprint}\nThis could mean someone is intercepting the connection.`
          : `The authenticity of ${key} can't be established.\nFingerprint: ${fingerprint}`;
        const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Trust and Connect');
        if (choice !== 'Trust and Connect') return false;
        await this.context.globalState.update(KNOWN_HOSTS_KEY, { ...known, [key]: fingerprint });
        return true;
      },
    };
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.cleanup();
    if (client) {
      try {
        await client.end();
      } catch {
        // Already gone.
      }
      this.log('Disconnected.');
    }
    this.setState('disconnected');
  }

  private handleClosed(): void {
    if (this.state !== 'connected') return;
    this.cleanup();
    this.log('Connection closed by the server.');
    this.setState('disconnected');
    vscode.window.showWarningMessage('Remote FTP: connection closed.', 'Reconnect').then(choice => {
      if (choice === 'Reconnect') this.connect();
    });
  }

  private cleanup(): void {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    this.client = undefined;
  }

  private startKeepalive(cfg: FtpConfig): void {
    if (cfg.protocol !== 'ftp' || cfg.keepalive <= 0) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.pending === 0) this.run(c => c.noop()).catch(() => undefined);
    }, cfg.keepalive);
  }

  /** Queues a task so only one command talks to the server at a time. */
  run<T>(task: (client: RemoteClient) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client || this.state !== 'connected') return Promise.reject(new Error('Not connected'));
    this.pending++;
    const result = this.queue.then(() => task(client)).finally(() => this.pending--);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.stateEmitter.fire(state);
  }

  // Path mapping between the project folder and config.remote.

  toRemote(localPath: string): string | undefined {
    if (!this.config) return undefined;
    const rel = path.relative(this.root.fsPath, localPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return posix.join(this.config.remote, rel.split(path.sep).join('/'));
  }

  toLocal(remotePath: string): string | undefined {
    if (!this.config) return undefined;
    const rel = posix.relative(this.config.remote, remotePath);
    if (rel.startsWith('..')) return undefined;
    return path.join(this.root.fsPath, ...rel.split('/').filter(Boolean));
  }

  dispose(): void {
    void this.disconnect();
    this.stateEmitter.dispose();
  }
}
