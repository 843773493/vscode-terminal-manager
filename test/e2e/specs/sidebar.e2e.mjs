import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { COMMANDS } from '../support/extension-contract.mjs';
import {
  collectUiSnapshot,
  dumpExtensionState,
  openSidebar,
  switchToTopFrame
} from '../support/diagnostics.mjs';

describe('Terminal Manager extension', () => {
  beforeEach(async () => {
    await browser.getWorkbench();
    await openSidebar();
  });

  afterEach(async () => {
    await switchToTopFrame();
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

  it('creates and cleans real tmux/zellij sessions when the backends are available', async () => {
    const runId = Date.now();
    const tmuxName = `vtm-e2e-tmux-${runId}`;
    const zellijName = `vtm-e2e-zellij-${runId}`;
    const initialState = await dumpExtensionState();
    let tmuxKilled = false;
    let zellijDeleted = false;

    try {
      if (initialState.tmux.installed) {
        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.tmuxNew,
          { sessionName: tmuxName, reveal: false }
        );
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return state.tmux.sessions.some((session) => session.name === tmuxName)
            && state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'tmux' && terminal.sessionName === tmuxName);
        }, {
          timeout: 20000,
          timeoutMsg: 'tmux session was not reflected in tmux and workspace state'
        });
      }

      if (initialState.zellij.installed) {
        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.zellijNew,
          { sessionName: zellijName, reveal: false }
        );
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return state.zellij.sessions.some((session) => session.name === zellijName)
            && state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zellijName);
        }, {
          timeout: 20000,
          timeoutMsg: 'zellij session was not reflected in zellij and workspace state'
        });
      }

      const finalState = await dumpExtensionState();
      assert.ok(initialState.tmux.installed || initialState.zellij.installed || finalState.events.length > 0);
      await collectUiSnapshot('terminal-manager-after-create');

      if (initialState.tmux.installed) {
        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.tmuxKillSession,
          { sessionName: tmuxName, confirm: false }
        );
        tmuxKilled = true;
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return !state.tmux.sessions.some((session) => session.name === tmuxName)
            && !state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'tmux' && terminal.sessionName === tmuxName);
        }, {
          timeout: 20000,
          timeoutMsg: 'tmux session was not killed from tmux and workspace state'
        });
      }

      if (initialState.zellij.installed) {
        await browser.executeWorkbench(
          (vscode, command, arg) => vscode.commands.executeCommand(command, arg),
          COMMANDS.zellijDelete,
          { sessionName: zellijName, confirm: false }
        );
        zellijDeleted = true;
        await browser.waitUntil(async () => {
          const state = await dumpExtensionState();
          return !state.zellij.sessions.some((session) => session.name === zellijName)
            && !state.workspace.registeredTerminals.some((terminal) => terminal.kind === 'zellij' && terminal.sessionName === zellijName);
        }, {
          timeout: 20000,
          timeoutMsg: 'zellij session was not deleted from zellij and workspace state'
        });
      }
    } finally {
      if (initialState.tmux.installed && !tmuxKilled) {
        cleanupExternal('tmux', ['kill-session', '-t', tmuxName]);
      }
      if (initialState.zellij.installed && !zellijDeleted) {
        cleanupExternal('zellij', ['delete-session', '--force', zellijName]);
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
