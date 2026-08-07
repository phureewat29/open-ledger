import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import semver from "semver";

function fail(reason: string): never {
  console.error(`release: ${reason}`);
  process.exit(1);
}

function run(command: string): void {
  execSync(command, { stdio: "inherit" });
}

const current: string = JSON.parse(readFileSync("package.json", "utf8")).version;

const requested = process.argv[2];
const next = requested
  ? semver.valid(requested) ?? fail(`"${requested}" is not a valid version, e.g. 0.11.4`)
  : semver.inc(current, "patch")!;

if (!semver.gt(next, current)) fail(`${next} is not newer than the current ${current}`);

console.log(`release: ${current} -> ${next}`);

run("npm run build"); // Fail fast: a broken build must abort before the version changes.
run(`npm version ${next} --no-git-tag-version`);
const pluginManifest = JSON.parse(readFileSync("plugin.json", "utf8"));
pluginManifest.version = next;
writeFileSync("plugin.json", `${JSON.stringify(pluginManifest, null, 2)}\n`);
run("git add package.json package-lock.json plugin.json");
run(`git commit -m "release: ${next}"`);
run("npm link");

console.log(`release: published ${next}`);
