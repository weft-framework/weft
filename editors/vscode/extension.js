// SPDX-License-Identifier: MIT
//
// The VS Code side of Weft: starts `weft lsp` (see server.js for which
// executable) and connects it to `.wx` documents. Highlighting comes from
// the TextMate grammar in syntaxes/; everything else (diagnostics, hover,
// go-to-definition, completion, rename, formatting, outline) from the
// language server.

"use strict";

const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const { resolveServer } = require("./server.js");

/** @type {LanguageClient | undefined} */
let client;

function folders() {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === "file")
    .map((f) => f.uri.fsPath);
}

async function start(context) {
  const setting = vscode.workspace.getConfiguration("weft").get("server.path");
  const command = resolveServer(setting, folders());
  const run = { command, args: ["lsp"], options: { shell: command.endsWith(".cmd") } };
  client = new LanguageClient(
    "weft",
    "Weft",
    { run, debug: run },
    {
      documentSelector: [{ scheme: "file", language: "weft" }],
      outputChannelName: "Weft",
    },
  );
  try {
    await client.start();
  } catch (err) {
    client = undefined;
    vscode.window.showErrorMessage(
      `Weft: could not start the language server (${command} lsp): ${err?.message ?? err}. ` +
        "Install the weft CLI or set `weft.server.path`.",
    );
  }
  context.subscriptions.push({ dispose: () => client?.stop() });
}

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("weft.restartServer", async () => {
      await client?.stop();
      await start(context);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("weft.server.path")) {
        await client?.stop();
        await start(context);
      }
    }),
  );
  await start(context);
}

async function deactivate() {
  await client?.stop();
}

module.exports = { activate, deactivate };
