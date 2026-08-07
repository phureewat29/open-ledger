import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import "dotenv/config";
import { AwsClient } from "aws4fetch";

function fail(reason: string): never {
  console.error(`publish:skills: ${reason}`);
  process.exit(1);
}

const REQUIRED_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) fail(`${missing.join(", ")} not set — see .env.example`);

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const CACHE_CONTROL = "public, max-age=300";
const PUBLIC_BASE = "https://cdn.openledger.sh";
const SKILLS_DIR = "skills";

/** Repo-relative posix paths of every file under skills/, which double as object keys. */
function skillFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...skillFiles(path));
    if (entry.isFile()) files.push(path.split("\\").join("/"));
  }
  return files;
}

const files = skillFiles(SKILLS_DIR);
if (files.length === 0) fail(`no files under ${SKILLS_DIR}/`);

const client = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  region: "auto",
  service: "s3",
});
const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`;

for (const key of files) {
  const response = await client.fetch(`${endpoint}/${key}`, {
    method: "PUT",
    body: readFileSync(key),
    headers: {
      "content-type": CONTENT_TYPES[extname(key)] ?? "application/octet-stream",
      "cache-control": CACHE_CONTROL,
    },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    fail(`PUT ${key} -> ${response.status}: ${body}`);
  }
  console.log(`uploaded ${key} -> ${PUBLIC_BASE}/${key}`);
}

console.log(`publish:skills: ${files.length} file(s) live under ${PUBLIC_BASE}/${SKILLS_DIR}/`);
