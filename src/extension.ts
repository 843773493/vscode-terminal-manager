import * as vscode from 'vscode';
import { DiagnosticLogger } from './diagnosticLogger';
import { TerminalManagerController } from './extensionController';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new DiagnosticLogger(context);
  const controller = new TerminalManagerController(context, logger);

  context.subscriptions.push(logger, controller);
}

export function deactivate(): void {
  // VS Code 会自动释放 context.subscriptions 中的资源。
}
