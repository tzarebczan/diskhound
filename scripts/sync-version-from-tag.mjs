import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const version = rawTag.replace(/^v/, "").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Refusing to sync package.json version from invalid tag: "${rawTag}"`);
  process.exit(1);
}

const packageJsonPath = resolve("package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version === version) {
  console.log(`package.json already at ${version}`);
  process.exit(0);
}

packageJson.version = version;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
console.log(`Synced package.json version to ${version}`);
