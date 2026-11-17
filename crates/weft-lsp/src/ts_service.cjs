// SPDX-License-Identifier: MIT
//
// The TypeScript half of `weft lsp`: a TypeScript language service over a
// project's compiled output (`.weft/lsp`), driven by the Rust server with
// one JSON request per line on stdin and one JSON response per line on
// stdout. Written next to the project by the server and run with the
// project's own `typescript` package:
//
//   node ts-service.cjs <typescript package dir> <compiled project dir>
//
// Requests: {id, op, file, line, character, overlays?: [{file, text}]}
// where `file` is a generated `.ts` path and positions are generated
// (zero-based, UTF-16) positions. Overlays replace a file's text (the
// editor's unsaved buffer, lowered) until replaced again. Ops:
//   hover       -> {display, docs, start, end} | null
//   completion  -> {member, entries: [{name, kind}]} | null
//   rename      -> {error} | {locations: [{file, start, end}]}
//   references  -> {locations: [{file, start, end}]}
// where start/end are {line, character}.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const [tsDir, outDir] = process.argv.slice(2);
const ts = require(tsDir);

const key = (f) => path.resolve(f);
const overlays = new Map();
let version = 0;
let config = { options: {}, fileNames: [] };
let configStamp = "";

function reloadConfig() {
  const file = path.join(outDir, "tsconfig.json");
  let stamp = "";
  try {
    stamp = String(fs.statSync(file).mtimeMs);
  } catch {
    return;
  }
  if (stamp === configStamp) {
    return;
  }
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host);
  if (parsed) {
    config = parsed;
    configStamp = stamp;
  }
}

const host = {
  getScriptFileNames: () => [...new Set([...config.fileNames.map(key), ...overlays.keys()])],
  getScriptVersion(f) {
    const o = overlays.get(key(f));
    if (o) {
      return `o${o.version}`;
    }
    try {
      return String(fs.statSync(f).mtimeMs);
    } catch {
      return "0";
    }
  },
  getScriptSnapshot(f) {
    const o = overlays.get(key(f));
    if (o) {
      return ts.ScriptSnapshot.fromString(o.text);
    }
    const text = ts.sys.readFile(f);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => outDir,
  getCompilationSettings: () => config.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: (f) => overlays.has(key(f)) || ts.sys.fileExists(f),
  readFile: (f, enc) => overlays.get(key(f))?.text ?? ts.sys.readFile(f, enc),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  realpath: ts.sys.realpath,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

function sourceFile(f) {
  return service.getProgram()?.getSourceFile(f);
}

function position(f, line, character) {
  const sf = sourceFile(f);
  if (!sf) {
    return undefined;
  }
  try {
    return ts.getPositionOfLineAndCharacter(sf, line, character);
  } catch {
    return undefined;
  }
}

function lc(f, pos) {
  const sf = sourceFile(f);
  return sf ? ts.getLineAndCharacterOfPosition(sf, pos) : { line: 0, character: 0 };
}

function span(f, s) {
  return { file: path.resolve(f), start: lc(f, s.start), end: lc(f, s.start + s.length) };
}

function handle(req) {
  reloadConfig();
  for (const o of req.overlays ?? []) {
    const k = key(o.file);
    if (overlays.get(k)?.text !== o.text) {
      overlays.set(k, { text: o.text, version: ++version });
    }
  }
  const file = req.file ? key(req.file) : "";
  const pos = file ? position(file, req.line, req.character) : undefined;
  if (pos === undefined) {
    return null;
  }
  switch (req.op) {
    case "hover": {
      const info = service.getQuickInfoAtPosition(file, pos);
      if (!info) {
        return null;
      }
      return {
        display: ts.displayPartsToString(info.displayParts),
        docs: ts.displayPartsToString(info.documentation),
        start: lc(file, info.textSpan.start),
        end: lc(file, info.textSpan.start + info.textSpan.length),
      };
    }
    case "completion": {
      const r = service.getCompletionsAtPosition(file, pos, {});
      if (!r) {
        return null;
      }
      return {
        member: r.isMemberCompletion,
        entries: r.entries
          .filter((e) => !e.name.startsWith("__weft"))
          .slice(0, 1000)
          .map((e) => ({ name: e.name, kind: e.kind })),
      };
    }
    case "rename": {
      const info = service.getRenameInfo(file, pos, {});
      if (!info.canRename) {
        return { error: info.localizedErrorMessage };
      }
      const locs = service.findRenameLocations(file, pos, false, false, {}) ?? [];
      return { locations: locs.map((l) => span(l.fileName, l.textSpan)) };
    }
    case "references": {
      const refs = service.getReferencesAtPosition(file, pos) ?? [];
      return { locations: refs.map((r) => span(r.fileName, r.textSpan)) };
    }
    default:
      return null;
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  let reply;
  try {
    reply = { id: req.id, result: handle(req) };
  } catch (err) {
    reply = { id: req.id, error: String(err?.stack ?? err) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
rl.on("close", () => process.exit(0));
