import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG_SECTION, OUTPUT_CHANNEL_NAME } from './constants';

export class DiagnosticLogger {
  private readonly output: vscode.OutputChannel;
  private readonly logFile: string;

  constructor(context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    const logDir = path.join(context.globalStorageUri.fsPath, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, 'extension-events.jsonl');
    this.write('extension.activated', {
      extensionPath: context.extensionUri.fsPath,
      storagePath: context.globalStorageUri.fsPath
    });
  }

  public get path(): string {
    return this.logFile;
  }

  public write(name: string, data?: unknown): void {
    const entry = {
      at: new Date().toISOString(),
      pid: process.pid,
      name,
      data
    };
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(this.logFile, line, 'utf8');

    const mirrorToOutput = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>('logToOutput', true);

    if (mirrorToOutput) {
      this.output.appendLine(line.trimEnd());
    }
  }

  public dispose(): void {
    this.output.dispose();
  }
}
