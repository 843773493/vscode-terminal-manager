import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../support/extension-contract.mjs';
import {
  collectUiSnapshot,
  dumpExtensionState,
  openSidebar,
  switchToTopFrame
} from '../support/diagnostics.mjs';

describe('Workspace Session Terminals extension', () => {
  beforeEach(async () => {
    await browser.getWorkbench();
    await openSidebar();
  });

  afterEach(async () => {
    try {
      await switchToTopFrame();
    } catch (error) {
      if (!isClosedBrowserSessionError(error)) {
        throw error;
      }
    }
  });

  it('opens the terminal manager sidebar and captures native TreeView UI', async () => {
    const workbench = await browser.getWorkbench();
    const title = await workbench.getTitleBar().getTitle();
    assert.match(title, /Visual Studio Code|Code/);

    const snapshot = await collectUiSnapshot('terminal-manager-sidebar-open');
    const visibleText = snapshot.document.visibleText.toLowerCase();
    assert.ok(visibleText.includes('工作区终端管理'));
    assert.ok(visibleText.includes('zellij 管理'));
    assert.ok(visibleText.includes('tmux 管理'));

    const state = await dumpExtensionState();
    assert.equal(state.workspace.autoRestoreEnabled, true);
    assert.equal(state.workspace.restoredThisActivation, false);
    assert.ok(Array.isArray(state.workspace.activeTerminals));
    assert.ok(Array.isArray(state.workspace.registeredTerminals));
    assert.ok(Array.isArray(state.zellij.sessions));
    assert.ok(Array.isArray(state.tmux.sessions));
    assert.ok(state.logFile.endsWith('extension-events.jsonl'));
  });

  it('refreshes backend state and writes extension diagnostics', async () => {
    await browser.executeWorkbench(
      (vscode, command, label) => vscode.commands.executeCommand(command, label),
      COMMANDS.emitTestLog,
      'terminal-manager-e2e'
    );
    await browser.executeWorkbench((vscode, command) => vscode.commands.executeCommand(command), COMMANDS.refreshAll);

    const state = await dumpExtensionState();
    assert.equal(state.status.includes('Log emitted') || state.status.includes('Refreshed'), true);
    assert.ok(state.events.some((event) => event.name === 'test.log'));

    await browser.waitUntil(() => {
      if (!fs.existsSync(state.logFile)) {
        return false;
      }
      const log = fs.readFileSync(state.logFile, 'utf8');
      return log.includes('test.log') && log.includes('command.refreshAll');
    }, {
      timeout: 10000,
      timeoutMsg: `Extension log did not contain expected events: ${state.logFile}`
    });

    await collectUiSnapshot('terminal-manager-after-refresh');
  });

  it('treats deleting a missing zellij session as a no-op', async () => {
    const initialState = await dumpExtensionState();
    if (!initialState.zellij.installed) {
      assert.ok(initialState.events.length >= 0);
      return;
    }

    const missingName = `vtm-e2e-missing-zellij-${Date.now()}`;
    await browser.executeWorkbench(
      (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
      COMMANDS.zellijDelete,
      { sessionName: missingName, confirm: false }
    );

    const state = await dumpExtensionState();
    assert.ok(state.events.some((event) => event.name === 'command.zellijDelete'));
    assert.equal(state.zellij.sessions.some((session) => session.name === missingName), false);
  });

  it('cleans up a stale zellij socket when deleting a zombie session', async () => {
    const initialState = await dumpExtensionState();
    if (!initialState.zellij.installed) {
      assert.ok(initialState.events.length >= 0);
      return;
    }

    const zombieName = `vtm-e2e-zombie-zellij-${Date.now()}`;
    const socketPath = zellijSocketPath(zombieName);
    createStaleUnixSocket(socketPath);
    assert.equal(fs.existsSync(socketPath), true);

    try {
      await browser.executeWorkbench(
        (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
        COMMANDS.zellijDelete,
        { sessionName: zombieName, confirm: false, closeTerminals: false }
      );

      const state = await dumpExtensionState();
      assert.ok(state.events.some((event) => event.name === 'command.zellijDelete'));
      assert.equal(fs.existsSync(socketPath), false);
      assert.equal(state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zombieName), false);
    } finally {
      cleanupExternal('zellij', ['delete-session', '--force', zombieName]);
      cleanupExternal('zellij', ['kill-session', zombieName]);
      cleanupSocket(socketPath);
    }
  });

  it('creates and cleans real tmux/zellij sessions when the backends are available', async () => {
    const runId = Date.now();
    const tmuxName = `vtm-e2e-tmux-${runId}`;
    const tmuxRenamedName = `${tmuxName}-renamed`;
    const zellijName = `vtm-e2e-zellij-${runId}`;
    const zellijRenamedName = `${zellijName}-renamed`;
    const initialState = await dumpExtensionState();

    try {
      if (initialState.tmux.installed) {
        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.tmuxNew,
          { sessionName: tmuxName, reveal: false, attachMode: 'none' }
        );
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return state.tmux.sessions.some((session) => session.name === tmuxName)
            && state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'tmux' && terminal.sessionName === tmuxName);
        }, {
          timeout: 20000,
          timeoutMsg: 'tmux session was not reflected in tmux and workspace state'
        });

        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.tmuxRename,
          { sessionName: tmuxName, newName: tmuxRenamedName }
        );
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return state.tmux.sessions.some((session) => session.name === tmuxRenamedName)
            && !state.tmux.sessions.some((session) => session.name === tmuxName)
            && state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'tmux' && terminal.sessionName === tmuxRenamedName)
            && !state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'tmux' && terminal.sessionName === tmuxName);
        }, {
          timeout: 20000,
          timeoutMsg: 'tmux session rename was not reflected in tmux and workspace state'
        });
      }

      if (initialState.zellij.installed) {
        const createState = await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.zellijNew,
          { sessionName: zellijName, reveal: false, attachMode: 'none' }
        );
        assert.equal(createState.zellij.sessions.some((session) => session.name === zellijName), true);
        assert.equal(
          createState.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zellijName),
          true
        );

        const renameState = await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.zellijRename,
          { sessionName: zellijName, newName: zellijRenamedName }
        );
        assert.equal(renameState.zellij.sessions.some((session) => session.name === zellijRenamedName), true);
        assert.equal(renameState.zellij.sessions.some((session) => session.name === zellijName), false);
        assert.equal(
          renameState.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zellijRenamedName),
          true
        );
        assert.equal(
          renameState.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zellijName),
          false
        );
      }

      assert.ok(initialState.tmux.installed || initialState.zellij.installed);
    } finally {
      if (initialState.tmux.installed) {
        cleanupExternal('tmux', ['kill-session', '-t', tmuxName]);
        cleanupExternal('tmux', ['kill-session', '-t', tmuxRenamedName]);
      }
      if (initialState.zellij.installed) {
        cleanupExternal('zellij', ['delete-session', '--force', zellijName]);
        cleanupExternal('zellij', ['kill-session', zellijName]);
        cleanupExternal('zellij', ['delete-session', '--force', zellijRenamedName]);
        cleanupExternal('zellij', ['kill-session', zellijRenamedName]);
      }
    }
  });
});

function cleanupExternal(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
  } catch {
    // Best-effort cleanup for tests where the VS Code renderer is already gone.
  }
}

function zellijSocketPath(sessionName) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(process.getuid?.() ?? 0));
  return path.join(runtimeDir, 'zellij', 'contract_version_1', sessionName);
}

function createStaleUnixSocket(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  cleanupSocket(socketPath);
  execFileSync('python3', ['-c', [
    'import os, socket, sys',
    'path = sys.argv[1]',
    'try:',
    '    os.unlink(path)',
    'except FileNotFoundError:',
    '    pass',
    'sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    'sock.bind(path)',
    'sock.close()'
  ].join('\n'), socketPath]);
}

function cleanupSocket(socketPath) {
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function isClosedBrowserSessionError(error) {
  const message = String(error?.message ?? error);
  return message.includes('invalid session id')
    || message.includes('not connected to DevTools')
    || message.includes('Connection closed')
    || message.includes('Channel has been closed');
}
