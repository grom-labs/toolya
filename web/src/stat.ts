// Anonymous, aggregate-only telemetry: did enable/connect succeed, on which OS +
// browser, and where it broke. No device IDs, serials, IP, or personal data — just
// coarse counters so we can see where rooting fails. Honors Do-Not-Track, and never
// blocks or throws into the root flow.

const DNT =
  typeof navigator !== "undefined" &&
  (navigator.doNotTrack === "1" ||
    (navigator as unknown as { doNotTrack?: string }).doNotTrack === "yes");

// A random per-browser id (not derived from the device — never the serial), so the
// funnel can be counted by unique browsers. Persists in localStorage; falls back to a
// per-load random id in private mode. Only ever sent when telemetry is on (not under DNT).
const CID = (() => {
  const rnd = () => {
    try {
      return crypto.randomUUID();
    } catch {
      return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  };
  try {
    let id = localStorage.getItem("toolya.cid");
    if (!id) {
      id = rnd();
      localStorage.setItem("toolya.cid", id);
    }
    return id;
  } catch {
    return rnd();
  }
})();

function platform(): { os: string; browser: string } {
  const ua = navigator.userAgent;
  let os = "other";
  if (/Windows/i.test(ua)) os = "win";
  else if (/Android/i.test(ua)) os = "android";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "mac";
  else if (/Linux|X11/i.test(ua)) os = "linux";

  let browser = "other";
  if (/Edg\//i.test(ua)) browser = "edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "opera";
  else if (/Chrome\//i.test(ua)) browser = "chrome";
  else if (/Firefox\//i.test(ua)) browser = "firefox";
  else if (/Safari\//i.test(ua)) browser = "safari";
  return { os, browser };
}

export function stat(ev: string, extra: { stage?: string; reason?: string } = {}): void {
  if (DNT) return;
  if ((window as unknown as { __TOOLYA_DRY_RUN__?: unknown }).__TOOLYA_DRY_RUN__) return; // demo mode
  try {
    const { os, browser } = platform();
    const body = JSON.stringify({ ev, os, browser, stage: extra.stage ?? "", reason: extra.reason ?? "", cid: CID });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/stat", new Blob([body], { type: "application/json" }));
    } else {
      void fetch("/api/stat", {
        method: "POST",
        body,
        keepalive: true,
        headers: { "content-type": "application/json" },
      });
    }
  } catch {
    /* telemetry must never break the tool */
  }
}
