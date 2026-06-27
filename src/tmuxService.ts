import { errorMessage, execFileText, isMissingExecutable } from './processRunner';
import type { BackendState, TmuxPane, TmuxSession, TmuxWindow } from './types';

const TMUX_FIELD_SEPARATOR = '\t';

export class TmuxService {
  private installed: boolean | undefined;
  private sessions: TmuxSession[] = [];
  private lastError: string | undefined;

  public async refresh(): Promise<TmuxSession[]> {
    if (!(await this.checkInstallation())) {
      this.sessions = [];
      return [];
    }

    try {
      this.sessions = await this.readTmuxTree();
      this.lastError = undefined;
      return this.sessions;
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('no server running')) {
        this.sessions = [];
        this.lastError = undefined;
        return [];
      }

      this.lastError = message;
      throw error;
    }
  }

  public getCachedSessions(): TmuxSession[] {
    return this.sessions;
  }

  public state(autoRefreshEnabled: boolean): BackendState<TmuxSession> {
    return {
      installed: this.installed === true,
      autoRefreshEnabled,
      lastError: this.lastError,
      sessions: this.sessions
    };
  }

  public async getSessionNames(): Promise<string[]> {
    const sessions = await this.refresh();
    return sessions.map((session) => session.name);
  }

  public async createSession(sessionName: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['new-session', '-d', '-s', sessionName]);
    await this.refresh();
  }

  public async renameSession(oldName: string, newName: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['rename-session', '-t', oldName, newName]);
    await this.refresh();
  }

  public async killSession(sessionName: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['kill-session', '-t', sessionName]);
    await this.refresh();
  }

  public async renameWindow(sessionName: string, windowIndex: string, newName: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['rename-window', '-t', `${sessionName}:${windowIndex}`, newName]);
    await this.refresh();
  }

  public async newWindow(sessionName: string, windowName?: string): Promise<void> {
    await this.requireTmux();
    const args = ['new-window', '-t', sessionName];
    if (windowName) {
      args.push('-n', windowName);
    }
    await execFileText('tmux', args);
    await this.refresh();
  }

  public async killWindow(sessionName: string, windowIndex: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['kill-window', '-t', `${sessionName}:${windowIndex}`]);
    await this.refresh();
  }

  public async killPane(sessionName: string, windowIndex: string, paneIndex: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['kill-pane', '-t', `${sessionName}:${windowIndex}.${paneIndex}`]);
    await this.refresh();
  }

  public async splitPane(sessionName: string, windowIndex: string, paneIndex: string, direction: 'right' | 'down'): Promise<void> {
    await this.requireTmux();
    const tmuxDirection = direction === 'right' ? '-h' : '-v';
    await execFileText('tmux', ['split-window', tmuxDirection, '-t', `${sessionName}:${windowIndex}.${paneIndex}`]);
    await this.refresh();
  }

  public async selectWindow(sessionName: string, windowIndex: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['select-window', '-t', `${sessionName}:${windowIndex}`]);
  }

  public async selectPane(sessionName: string, windowIndex: string, paneIndex: string): Promise<void> {
    await this.requireTmux();
    await execFileText('tmux', ['select-pane', '-t', `${sessionName}:${windowIndex}.${paneIndex}`]);
  }

  private async requireTmux(): Promise<void> {
    if (!(await this.checkInstallation())) {
      throw new Error('tmux is not installed or not in PATH.');
    }
  }

  private async checkInstallation(): Promise<boolean> {
    if (this.installed !== undefined) {
      return this.installed;
    }

    try {
      await execFileText('tmux', ['-V']);
      this.installed = true;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.installed = false;
      this.lastError = isMissingExecutable(error)
        ? 'tmux is not installed or not in PATH.'
        : errorMessage(error);
      return false;
    }
  }

  private async readTmuxTree(): Promise<TmuxSession[]> {
    const sessionFormat = [
      '#{session_name}',
      '#{session_attached}',
      '#{session_created}',
      '#{session_activity}'
    ].join(TMUX_FIELD_SEPARATOR);
    const sessionsOutput = await execFileText('tmux', ['list-sessions', '-F', sessionFormat]);
    if (!sessionsOutput.stdout.trim()) {
      return [];
    }

    const windowFormat = [
      '#{session_name}',
      '#{window_index}',
      '#{window_name}',
      '#{window_active}'
    ].join(TMUX_FIELD_SEPARATOR);
    const paneFormat = [
      '#{session_name}',
      '#{window_index}',
      '#{pane_index}',
      '#{pane_current_command}',
      '#{pane_current_path}',
      '#{pane_active}',
      '#{pane_pid}'
    ].join(TMUX_FIELD_SEPARATOR);

    const [windowsOutput, panesOutput] = await Promise.all([
      execFileText('tmux', ['list-windows', '-a', '-F', windowFormat]),
      execFileText('tmux', ['list-panes', '-a', '-F', paneFormat])
    ]);

    return this.parseTmuxData(sessionsOutput.stdout, windowsOutput.stdout, panesOutput.stdout);
  }

  private parseTmuxData(sessionsData: string, windowsData: string, panesData: string): TmuxSession[] {
    const sessions = new Map<string, TmuxSession>();
    for (const line of splitLines(sessionsData)) {
      const [name, attached, created, activity] = line.split(TMUX_FIELD_SEPARATOR);
      if (!name) {
        continue;
      }

      sessions.set(name, {
        name,
        isAttached: attached === '1',
        created: created ?? '',
        lastActivity: activity ?? '',
        windows: []
      });
    }

    const panesByWindow = new Map<string, TmuxPane[]>();
    for (const line of splitLines(panesData)) {
      const [sessionName, windowIndex, paneIndex, command, currentPath, active, pid] = line.split(TMUX_FIELD_SEPARATOR);
      if (!sessionName || !windowIndex || !paneIndex) {
        continue;
      }

      const key = `${sessionName}:${windowIndex}`;
      const panes = panesByWindow.get(key) ?? [];
      panes.push({
        sessionName,
        windowIndex,
        index: paneIndex,
        command: command || 'shell',
        currentPath: currentPath || '~',
        isActive: active === '1',
        pid: Number.parseInt(pid ?? '0', 10) || 0
      });
      panesByWindow.set(key, panes);
    }

    const windowsBySession = new Map<string, TmuxWindow[]>();
    for (const line of splitLines(windowsData)) {
      const [sessionName, windowIndex, name, active] = line.split(TMUX_FIELD_SEPARATOR);
      if (!sessionName || !windowIndex) {
        continue;
      }

      const windows = windowsBySession.get(sessionName) ?? [];
      windows.push({
        sessionName,
        index: windowIndex,
        name: name || 'window',
        isActive: active === '1',
        panes: panesByWindow.get(`${sessionName}:${windowIndex}`) ?? []
      });
      windowsBySession.set(sessionName, windows);
    }

    return [...sessions.values()].map((session) => ({
      ...session,
      windows: windowsBySession.get(session.name) ?? []
    }));
  }
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}
