// The resume log, with the trap closed.
//
// Every mutating script in this repo appends what it did to a JSON file and
// SKIPS anything already listed. That makes a run resumable, and it is the right
// design. The trap is that the file is chosen by editing a constant, so pointing
// a new round at the previous round's log makes the script skip every item and
// do nothing — silently, reporting success.
//
// That happened. Commit 95bdd69: "PROGRESS_FILE is a resume log, not a record of
// holdings, so round 2 gets its own file rather than reusing round 1's - which
// would have skipped all 14 pools and seeded nothing."
//
// So here a non-empty progress file is an ERROR unless the caller explicitly
// says it is resuming.

import fs from "fs";
import path from "path";

export class ProgressReuseError extends Error {
  constructor(file, count, last) {
    super(
      `progress file ${file} already has ${count} entr${count === 1 ? "y" : "ies"}` +
        (last ? ` (last: ${last})` : "") +
        `.\n` +
        `  It is a RESUME LOG, not a record. Every item in it will be SKIPPED.\n` +
        `  - resuming an interrupted run?  pass --resume\n` +
        `  - starting a new round?         choose a new --progress path`
    );
    this.name = "ProgressReuseError";
    this.code = "PROGRESS_REUSE";
  }
}

/**
 * Open an append-only progress log.
 *
 * `key` identifies an item within a `kind`, so `has(kind, key)` is the skip
 * check. Writes are atomic (temp file + rename) so an interrupted run cannot
 * leave truncated JSON behind — which would strand the whole round.
 */
export function openProgress(file, { allowResume = false } = {}) {
  const abs = path.resolve(file);
  let entries = [];

  if (fs.existsSync(abs)) {
    const raw = fs.readFileSync(abs, "utf8").trim();
    if (raw) {
      try {
        entries = JSON.parse(raw);
      } catch (e) {
        throw new Error(`progress file ${file} exists but is not valid JSON: ${e.message}`);
      }
      if (!Array.isArray(entries)) throw new Error(`progress file ${file} is not a JSON array`);
      if (entries.length && !allowResume) {
        const last = entries[entries.length - 1];
        throw new ProgressReuseError(file, entries.length, last && (last.key ?? last.kind));
      }
    }
  }

  const seen = new Set(entries.map((e) => `${e.kind}\u0000${e.key}`));

  const flush = () => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    fs.renameSync(tmp, abs);
  };

  return {
    path: abs,
    entries,
    get count() {
      return entries.length;
    },
    has(kind, key) {
      return seen.has(`${kind}\u0000${key}`);
    },
    /**
     * Append and persist immediately.
     *
     * Returns the STORED object, not a copy, so a caller can record something
     * irreversible first and fill in the rest afterwards with `flush()`. The
     * creators need exactly that: a market address must be written the moment
     * the transaction confirms, because if a transient MarketView failure threw
     * before it was saved, the next run would create a DUPLICATE market for the
     * same question — and creation is not idempotent.
     */
    append(entry) {
      if (!entry || !entry.kind) throw new Error("progress entry needs a `kind`");
      const stored = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
      entries.push(stored);
      seen.add(`${entry.kind}\u0000${entry.key}`);
      flush();
      return stored;
    },
    /** Persist in-place edits to an entry returned by `append`. */
    flush,
  };
}
