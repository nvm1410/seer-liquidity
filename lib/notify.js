// Push a notification to ntfy.sh (or a self-hosted ntfy via NTFY_SERVER).
//
// The topic name is the only secret: anyone who knows it can read and post.
// Use a long random string. With NTFY_TOPIC unset this is a no-op that says so,
// and a failed POST is logged, never thrown — a notification is never worth
// failing the run that it is reporting on.

export async function notify({ title, body, priority = "default", tags = [] }, { log = console } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    log.log(`  notify: NTFY_TOPIC unset, not sent — ${title}`);
    return false;
  }
  const server = (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      // Header values must be ASCII; the title carries ids and statuses only.
      headers: { Title: title.replace(/[^\x20-\x7e]/g, "?"), Priority: priority, Tags: tags.join(",") },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    log.error(`  notify: failed (${e.message}) — ${title}`);
    return false;
  }
}
