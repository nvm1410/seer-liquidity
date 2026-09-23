// A console that also writes to a file.
//
// Every run log in archive/runs/ was produced by shell redirection that none of
// the runbooks actually mention, which is why twelve of them were never
// committed at all. A run should capture its own transcript.

import fs from "fs";
import path from "path";

export function createLogger({ file = null } = {}) {
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    stream = fs.createWriteStream(path.resolve(file), { flags: "a" });
  }

  const write = (line) => {
    if (stream) stream.write(line + "\n");
  };
  const fmt = (args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  return {
    file,
    log: (...a) => { const s = fmt(a); console.log(s); write(s); },
    warn: (...a) => { const s = fmt(a); console.warn(s); write(s); },
    error: (...a) => { const s = fmt(a); console.error(s); write(s); },
    async close() {
      if (!stream) return;
      await new Promise((r) => stream.end(r));
      stream = null;
    },
  };
}
