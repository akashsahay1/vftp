# Remote FTP for VS Code

Browse and edit files on FTP, FTPS and SFTP servers from a sidebar, the same way as the Pulsar/Atom
`remote-ftp` package. Each project keeps its settings in a `.ftpconfig` file.

## Getting started

1. Open your project folder (**File → Open Folder…**).
2. Click the **Remote FTP** icon in the activity bar (or press `Ctrl+Alt+O`).
3. Click **Create FTP Config File** or **Create SFTP Config File**, then fill in host, user, password and `remote`.
4. Click **Connect**. The remote files and folders appear in the panel.
5. Right-click any folder or file for **Add File, Add Folder, Refresh, Rename, Delete, Download**.
   Clicking a file downloads it into the matching place in your project and opens it. Saving uploads it.

Tip: use **⋯ → Create Ignore File** to make a `.ftpignore` (gitignore syntax) so sensitive files never get uploaded.
`.ftpconfig` itself is never uploaded.

You can also right-click files or folders in the normal Explorer and choose **Upload** or **Download from Remote**.

## Keyboard shortcuts

| Action     | Windows / Linux  | Mac              |
|------------|------------------|------------------|
| Toggle     | `Ctrl+Alt+O`     | `Ctrl+Alt+O`     |
| Connect    | `Ctrl+Alt+C`     | `Ctrl+Alt+C`     |
| Disconnect | `Ctrl+Alt+D`     | `Ctrl+Alt+D`     |
| Upload     | `Ctrl+Shift+U`   | `Cmd+Shift+U`    |

## .ftpconfig

Same options as remote-ftp. The file accepts `//` comments.

- **Both:** `protocol` (`"ftp"` or `"sftp"`), `host`, `port`, `user`, `pass`, `promptForPass`, `remote`,
  `connTimeout`, `keepalive`, `watch`, `watchTimeout`
- **FTP/FTPS:** `secure` (`false`, `true`, `"control"`, `"implicit"`), `secureOptions`, `pasvTimeout`
- **SFTP:** `agent`, `privatekey`, `passphrase`, `hosthash`, `ignorehost`, `keyboardInteractive`,
  `keyboardInteractiveForPass`, `filePermissions`

Differences from remote-ftp:

- `secure: "control"` encrypts the data connection as well (the FTP library always does).
- `ignorehost: false` asks you to trust the server's key on first connect, then warns if it changes.

## Settings

- `remoteFtp.autoUploadOnSave`: `always` (connect if needed), `onlyWhenConnected` or `never`
- `remoteFtp.connectOnStartup`: connect when a project with `.ftpconfig` opens
- `remoteFtp.showHiddenFiles`, `remoteFtp.hideIgnoredFiles`

The **Remote FTP** output channel logs every command and server reply.

## Development

```
npm install
npm run compile
```

Press `F5` in VS Code to start an Extension Development Host. `npm run package` builds a `.vsix`.
