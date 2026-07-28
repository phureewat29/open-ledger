import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
run("git add package.json package-lock.json");
run(`git commit -m "release: ${next}"`);
run("npm link"); // Expose the freshly built CLI on the global bin path.

console.log(`release: published ${next}`);
