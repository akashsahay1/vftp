export interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

/** UI callbacks a client needs while connecting. */
export interface ClientHooks {
  log(line: string): void;
  promptSecret(prompt: string, password: boolean): Promise<string | undefined>;
  verifyHost(fingerprint: string): Promise<boolean>;
}

/**
 * The operations the extension needs from a server. Calls are never made
 * concurrently: Connection serializes them through a queue.
 */
export interface RemoteClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  onClose(listener: () => void): void;
  pwd(): Promise<string>;
  list(dir: string): Promise<RemoteEntry[]>;
  exists(path: string): Promise<boolean>;
  download(remotePath: string, localPath: string): Promise<void>;
  upload(localPath: string, remotePath: string): Promise<void>;
  createEmptyFile(remotePath: string): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(dir: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Deletes the directory and everything in it. */
  deleteDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  noop(): Promise<void>;
}
