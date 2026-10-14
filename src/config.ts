import * as vscode from 'vscode';
import { posix } from 'path';
import { parse, printParseErrorCode, ParseError } from 'jsonc-parser';

export const CONFIG_FILE = '.ftpconfig';
export const IGNORE_FILE = '.ftpignore';

export type Protocol = 'ftp' | 'sftp';

export interface FtpConfig {
  protocol: Protocol;
  host: string;
  port: number;
  user: string;
  pass?: string;
  promptForPass: boolean;
  remote: string;
  connTimeout: number;
  keepalive: number;
  watch: string[];
  watchTimeout: number;
  // FTP / FTPS
  secure: boolean | 'control' | 'implicit';
  secureOptions?: Record<string, unknown>;
  pasvTimeout: number;
  // SFTP
  agent?: string;
  privatekey?: string;
  passphrase?: string;
  hosthash?: string;
  ignorehost: boolean;
  keyboardInteractive: boolean;
  keyboardInteractiveForPass: boolean;
  filePermissions?: string;
}

/** Reads .ftpconfig (JSON with comments) from the project root and applies remote-ftp's defaults. */
export async function readConfig(root: vscode.Uri): Promise<FtpConfig> {
  const uri = vscode.Uri.joinPath(root, CONFIG_FILE);
  const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split('\n').length;
    throw new Error(`${CONFIG_FILE} is not valid JSON (${printParseErrorCode(e.error)} on line ${line}).`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object.`);
  }

  const protocol = String(raw.protocol ?? 'ftp').toLowerCase();
  if (protocol !== 'ftp' && protocol !== 'sftp') {
    throw new Error(`${CONFIG_FILE}: "protocol" must be "ftp" or "sftp" (use "secure" for FTPS).`);
  }
  const sftp = protocol === 'sftp';
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

  return {
    protocol,
    host: str(raw.host) ?? 'localhost',
    port: num(raw.port, sftp ? 22 : 21),
    user: str(raw.user) ?? (sftp ? '' : 'anonymous'),
    pass: typeof raw.pass === 'string' ? raw.pass : sftp ? undefined : 'anonymous@',
    promptForPass: raw.promptForPass === true,
    remote: normalizeRemote(str(raw.remote) ?? '/'),
    connTimeout: num(raw.connTimeout, 10000),
    keepalive: num(raw.keepalive, 10000),
    watch: Array.isArray(raw.watch) ? raw.watch.filter((w: unknown): w is string => typeof w === 'string') : [],
    watchTimeout: num(raw.watchTimeout, 500),
    secure: raw.secure === 'control' || raw.secure === 'implicit' ? raw.secure : raw.secure === true,
    secureOptions: raw.secureOptions && typeof raw.secureOptions === 'object' ? raw.secureOptions : undefined,
    pasvTimeout: num(raw.pasvTimeout, 10000),
    agent: str(raw.agent),
    privatekey: str(raw.privatekey),
    passphrase: str(raw.passphrase),
    hosthash: str(raw.hosthash),
    ignorehost: raw.ignorehost !== false,
    keyboardInteractive: raw.keyboardInteractive === true,
    keyboardInteractiveForPass: raw.keyboardInteractiveForPass === true,
    filePermissions: str(raw.filePermissions),
  };
}

function normalizeRemote(remote: string): string {
  let r = posix.normalize(remote.replace(/\\/g, '/'));
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

export const FTP_TEMPLATE = `{
    "protocol": "ftp",
    "host": "example.com", // Hostname or IP address of the server. Default: "localhost"
    "port": 21, // Port of the FTP server. Default: 21
    "user": "user", // Username. Default: "anonymous"
    "pass": "pass", // Password. Default: "anonymous@"
    "promptForPass": false, // true = ask for the password when connecting instead of storing it here
    "remote": "/", // Remote folder that maps to this project folder
    "secure": false, // true = encrypt control + data (explicit FTPS), "control" = control only, "implicit" = implicit FTPS (usually port 990)
    "secureOptions": null, // Extra options for tls.connect(), e.g. { "rejectUnauthorized": false } for self-signed certificates
    "connTimeout": 10000, // How long (ms) to wait for the control connection. Default: 10000
    "pasvTimeout": 10000, // How long (ms) to wait for a PASV data connection. Default: 10000
    "keepalive": 10000, // How often (ms) to send NOOP to keep the connection alive. 0 disables. Default: 10000
    "watch": [ // Files, folders or globs (relative to the project root) uploaded when changed outside the editor
    ],
    "watchTimeout": 500 // Delay (ms) after the last change before the upload starts
}
`;

export const SFTP_TEMPLATE = `{
    "protocol": "sftp",
    "host": "example.com", // Hostname or IP address of the server. Default: "localhost"
    "port": 22, // Port of the server. Default: 22
    "user": "user", // Username
    "pass": "pass", // Password
    "promptForPass": false, // true = ask for the password/passphrase when connecting instead of storing it here
    "remote": "/", // Remote folder that maps to this project folder. Try to use absolute paths starting with /
    "agent": "", // ssh-agent socket path. "env" uses SSH_AUTH_SOCK; on Windows use "pageant"
    "privatekey": "", // Absolute path to a private key file (OpenSSH format)
    "passphrase": "", // Passphrase for an encrypted private key
    "hosthash": "", // "md5" or "sha1": hash used for the host key fingerprint
    "ignorehost": true, // false = ask to trust the server's host key on first connect and check it afterwards
    "connTimeout": 10000, // How long (ms) to wait for the SSH handshake. Default: 10000
    "keepalive": 10000, // How often (ms) to send SSH keepalive packets. 0 disables. Default: 10000
    "keyboardInteractive": false, // true = show a dialog for keyboard-interactive prompts (e.g. 2FA codes)
    "keyboardInteractiveForPass": false, // true = answer keyboard-interactive prompts with "pass" without a dialog
    "watch": [ // Files, folders or globs (relative to the project root) uploaded when changed outside the editor
    ],
    "watchTimeout": 500, // Delay (ms) after the last change before the upload starts
    "filePermissions": "" // e.g. "0644": permissions set on uploaded files. Overwrites existing remote permissions!
}
`;

export const IGNORE_TEMPLATE = `# Files and folders matching these patterns are never uploaded or downloaded.
# Same syntax as .gitignore. .ftpconfig is always ignored.
.ftpignore
.git/
.vscode/
node_modules/
.DS_Store
Thumbs.db
`;
