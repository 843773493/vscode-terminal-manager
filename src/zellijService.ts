import { errorMessage, execFileText, isMissingExecutable } from './processRunner';
import type { BackendState, ZellijSession } from './types';

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
      await execFileText('zellij', ['kill-session', sessionName]);
    } catch (error) {
      if (!isMissingZellijSession(error)) {
        throw error;
      }
    }
    await this.refresh();
  }

  public async deleteSession(sessionName: string): Promise<void> {
    await this.requireZellij();
    try {
      await execFileText('zellij', ['delete-session', '--force', sessionName]);
    } catch (error) {
      if (!isMissingZellijSession(error)) {
        throw error;
      }
    }
    await this.refresh();
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
  return /Session: ".*" not found\.|No session named ".*" found\./.test(errorMessage(error));
}
