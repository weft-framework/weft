#!/usr/bin/env node
import { createProject } from "./index.js";

const args = process.argv.slice(2);
const tailwind = args.includes("--tailwind");
const minimal = args.includes("--minimal");
const name = args.find((a) => a !== "--tailwind" && a !== "--minimal");
if (!name || name === "--help" || name === "-h") {
  console.log("usage: npm create @weft-framework <name> [-- --minimal [--tailwind]]");
  process.exit(name ? 0 : 2);
}

try {
  createProject(name, process.cwd(), { minimal, tailwind });
  console.log(`Created ${name}\n\nNext:\n  cd ${name}\n  npm install\n  npm run dev`);
} catch (err) {
  console.error(`create: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
}
