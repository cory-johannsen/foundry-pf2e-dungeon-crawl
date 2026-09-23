import { readFileSync } from "node:fs";

/** Reads `name` from the real shell environment first, falling back to a
 * `.env` file in the current working directory. */
export function readEnvOrDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}
