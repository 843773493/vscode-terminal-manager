import * as cp from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface ProcessFailure extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export function execFileText(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 10000,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as ProcessFailure;
          failure.stdout = typeof stdout === 'string' ? stdout : String(stdout);
          failure.stderr = typeof stderr === 'string' ? stderr : String(stderr);
          reject(failure);
          return;
        }

        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr)
        });
      }
    );
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const failure = error as ProcessFailure;
    const stderr = failure.stderr?.trim();
    return stderr ? `${error.message}: ${stderr}` : error.message;
  }

  return String(error);
}

export function isMissingExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const failure = error as ProcessFailure;
  return failure.code === 'ENOENT';
}

export function isProcessTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const failure = error as ProcessFailure;
  return failure.killed === true
    || failure.signal === 'SIGTERM'
    || /timed out|timeout/i.test(error.message);
}
