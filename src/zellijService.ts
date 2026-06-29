import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { errorMessage, execFileText, isMissingExecutable, isProcessTimeout } from './processRunner';
import type { BackendState, ZellijSession } from './types';

const ZELLIJ_SESSION_REMOVAL_TIMEOUT_MS = 4000;
const ZELLIJ_CONTRACT_VERSION = 'contract_version_1';

export class ZellijService {
  private installed: boolean | undefined;
  private sessions: ZellijSession[] = [];
  private lastError: string | undefined;

  public async refresh(): Promise<ZellijSession[]> {
    if (!(await this.checkInstallation())) {
      this.sessions = [];
      return [];
    }

    try {
      const output = await execFileText('zellij', ['list-sessions', '--no-formatting']);
      this.sessions = this.parseSessions(output.stdout);
      this.lastError = undefined;
      return this.sessions;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  public getCachedSessions(): ZellijSession[] {
    return this.sessions;
  }

  public state(autoRefreshEnabled: boolean): BackendState<ZellijSession> {
    return {
      installed: this.installed === true,
      autoRefreshEnabled,
      lastError: this.lastError,
      sessions: this.sessions
    };
  }

  public async createSession(sessionName: string): Promise<void> {
    await this.requireZellij();
    await execFileText('zellij', ['attach', '--create-background', sessionName], { timeoutMs: 15000 });
    await this.refresh();
  }

  public async renameSession(oldName: string, newName: string): Promise<void> {
    await this.requireZellij();
    await execFileText('zellij', ['--session', oldName, 'action', 'rename-session', newName]);
    await this.refresh();
  }

  public async killSession(sessionName: string): Promise<void> {
    await this.requireZellij();
    try {
      await execFileText('zellij', ['kill-session', sessionName], { timeoutMs: ZELLIJ_SESSION_REMOVAL_TIMEOUT_MS });
    } catch (error) {
      if (!isRemovableStaleZellijSession(error)) {
        throw error;
      }
      await cleanupStaleZellijSocket(sessionName);
    }
    await this.refreshAfterSessionRemoval(sessionName);
  }

  public async deleteSession(sessionName: string): Promise<void> {
    await this.requireZellij();
    try {
      await execFileText('zellij', ['delete-session', '--force', sessionName], { timeoutMs: ZELLIJ_SESSION_REMOVAL_TIMEOUT_MS });
    } catch (error) {
      if (!isRemovableStaleZellijSession(error)) {
        throw error;
      }
      await cleanupStaleZellijSocket(sessionName);
    }
    await this.refreshAfterSessionRemoval(sessionName);
  }

  private async requireZellij(): Promise<void> {
    if (!(await this.checkInstallation())) {
      throw new Error('zellij is not installed or not in PATH.');
    }
  }

  private async checkInstallation(): Promise<boolean> {
    if (this.installed !== undefined) {
      return this.installed;
    }

    try {
      await execFileText('zellij', ['--version']);
      this.installed = true;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.installed = false;
      this.lastError = isMissingExecutable(error)
        ? 'zellij is not installed or not in PATH.'
        : errorMessage(error);
      return false;
    }
  }

  private async refreshAfterSessionRemoval(sessionName: string): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      if (!isRemovableStaleZellijSession(error)) {
        throw error;
      }
      await cleanupStaleZellijSocket(sessionName);
      this.sessions = this.sessions.filter((session) => session.name !== sessionName);
      this.lastError = undefined;
    }
  }

  private parseSessions(output: string): ZellijSession[] {
    return output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(.*?)\s+\[(.*?)\](?:\s+\((.*?)\))?$/.exec(line);
        if (!match) {
          return {
            name: line,
            status: 'unknown' as const,
            raw: line
          };
        }

        const statusSummary = match[3] ?? '';
        return {
          name: match[1],
          createdSummary: match[2],
          status: statusSummary.toUpperCase().includes('EXITED') ? 'exited' : 'running',
          raw: line
        };
      });
  }
}

function isMissingZellijSession(error: unknown): boolean {
  return /Session: ".*" not found\.|No session named ".*" found\.|Os \{ code: 2, kind: NotFound, message: /.test(errorMessage(error));
}

function isRemovableStaleZellijSession(error: unknown): boolean {
  return isMissingZellijSession(error) || isProcessTimeout(error);
}

async function cleanupStaleZellijSocket(sessionName: string): Promise<void> {
  if (process.platform === 'win32' || !isSafeSocketName(sessionName)) {
    return;
  }

  const socketPath = path.join(zellijSocketRoot(), ZELLIJ_CONTRACT_VERSION, sessionName);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (!stat.isSocket() && !stat.isFile()) {
    return;
  }
  await fs.rm(socketPath, { force: true });
}

function zellijSocketRoot(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? defaultRuntimeDir();
  return path.join(runtimeDir, 'zellij');
}

function defaultRuntimeDir(): string {
  const getuid = process.getuid;
  return typeof getuid === 'function'
    ? path.join('/run/user', String(getuid()))
    : '/tmp';
}

function isSafeSocketName(sessionName: string): boolean {
  return Boolean(sessionName)
    && !sessionName.includes('\0')
    && !sessionName.includes('/')
    && !sessionName.includes('\\')
    && sessionName !== '.'
    && sessionName !== '..';
}
