import { spawn } from 'node:child_process';

export function openBrowser(url: URL): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', url.toString()]
      : [url.toString()];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Ignore errors; user can open manually.
  }
}
