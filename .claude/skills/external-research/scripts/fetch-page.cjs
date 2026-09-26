#!/usr/bin/env node
/**
 * Fetch one page with a real browser, for sources that serve nothing useful to a
 * plain HTTP fetch. Reports retrieval honestly — a block is reported as a block,
 * never as an empty result.
 *
 *   NODE_PATH=$(npm root -g) node fetch-page.cjs <url> [outfile] [options]
 *
 *   --text              save visible text instead of HTML
 *   --wait <selector>   wait for this selector before capturing
 *   --settle <ms>       wait for network idle, then this long, before capturing.
 *                       For pages whose content is injected after load — without it
 *                       you capture the empty shell and may read it as "no content".
 *   --profile <dir>     use a persistent browser profile (reuses a login)
 *   --headed            show the window (needed when a human logs in)
 *   --timeout <ms>      navigation timeout, default 45000
 *
 * A human establishes a login once with `--profile <dir> --headed`, then later
 * runs reuse that profile headlessly.
 */
const fs = require("fs");
const { chromium } = require("playwright");

// Unambiguous: these phrases only appear on an actual interstitial.
const CHALLENGE_MARKERS = [
  "Enter the characters you see below",
  "Type the characters you see in this image",
  "Robot Check",
  "unusual traffic from your computer",
  "Checking your browser before accessing",
  "cf-browser-verification",
  "Pardon Our Interruption",
];

// Generic enough to appear as ordinary content — an API reference that documents
// HTTP 403 responses contains "Access Denied" in a table (#10976). Only a block on
// a short page, since a real interstitial carries almost no content.
const WEAK_CHALLENGE_MARKERS = ["Access Denied"];
const WEAK_MARKER_MAX_BYTES = 20000;

function parseArguments(argv) {
  const positional = [];
  const options = { timeout: 45000 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--text") options.text = true;
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--wait") options.wait = argv[++index];
    else if (argument === "--settle") options.settle = Number(argv[++index]);
    else if (argument === "--profile") options.profile = argv[++index];
    else if (argument === "--timeout") options.timeout = Number(argv[++index]);
    else positional.push(argument);
  }
  return { url: positional[0], outputPath: positional[1], options };
}

function challengeMarkerIn(html) {
  const strong = CHALLENGE_MARKERS.find((marker) => html.includes(marker));
  if (strong) return strong;
  if (html.length >= WEAK_MARKER_MAX_BYTES) return undefined;
  return WEAK_CHALLENGE_MARKERS.find((marker) => html.includes(marker));
}

/**
 * Never claim "no data" — say which failure it looks like, or say it is
 * indeterminate. A generic error page is the trap: many vendors serve one
 * friendly 404 for every wrong URL, so a short body plus a 404 means the URL
 * was wrong, not that the vendor lacks the resource.
 */
function verdictFor(status, html, title, finalUrl, requestedUrl) {
  const challenge = challengeMarkerIn(html);
  if (challenge) return `BLOCKED_CHALLENGE (matched: "${challenge}")`;
  if (status === 401 || status === 403) return `BLOCKED_HTTP_${status} — refused this client; credentials or a different route needed`;
  if (status === 429) return "BLOCKED_RATE_LIMITED — back off and retry later";
  if (status === 404) return "HTTP_404 — this URL is wrong or gone; NOT evidence the resource does not exist";
  if (status >= 400) return `HTTP_${status}`;

  // A soft 404 answers 200 with an error page. Trusting the status code here is
  // how "the vendor does not publish this" gets written down: caught in testing,
  // where a docs site served 200 + "Page Not Found" + a /page/404 final URL.
  // The URL test is reliable on its own. The title test is not: a help article
  // legitimately titled "Error Code 5461 and approval requirements" is content,
  // not an error page. (Caught in testing — it sent three real articles unread.)
  // So a suspicious title only counts alongside a body too short to be an article.
  const errorUrl = /\/404(\b|\/|$)|\/page-not-found|\/error(\b|\/|$)/i.test(finalUrl || "");
  const errorTitle = /(^|\b)(page )?not found\b|page unavailable|^\s*(error|oops)\b/i.test(title || "");
  if (errorUrl || (errorTitle && html.length < WEAK_MARKER_MAX_BYTES)) {
    return `SOFT_404 — HTTP ${status} but the page is an error page (title: "${title}", final URL: ${finalUrl}); the URL is wrong, NOT evidence the resource is absent`;
  }
  if (finalUrl && requestedUrl && new URL(finalUrl).host !== new URL(requestedUrl).host) {
    return `OK_REDIRECTED_OFFHOST — landed on ${new URL(finalUrl).host}; confirm this is still the vendor before citing`;
  }
  if (html.length < 5000) return "SUSPECT_THIN — JS shell or soft block; inspect before treating as content";
  return "OK";
}

(async () => {
  const { url, outputPath, options } = parseArguments(process.argv.slice(2));
  if (!url) {
    console.error("usage: fetch-page.cjs <url> [outfile] [--text] [--wait <sel>] [--profile <dir>] [--headed] [--timeout <ms>]");
    process.exit(2);
  }

  const headless = !options.headed;
  const context = options.profile
    ? await chromium.launchPersistentContext(options.profile, { headless, locale: "en-US" })
    : await (await chromium.launch({ headless })).newContext({ locale: "en-US" });

  const page = await context.newPage();
  let status = 0;
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout });
    status = response ? response.status() : 0;
    if (options.wait) {
      await page.waitForSelector(options.wait, { timeout: options.timeout }).catch(() => {
        console.log(`WAIT_SELECTOR_MISSING: ${options.wait} — capturing anyway`);
      });
    }
    if (options.settle) {
      await page.waitForLoadState("networkidle", { timeout: options.timeout }).catch(() => {});
      await page.waitForTimeout(options.settle);
    }
  } catch (error) {
    console.log(`NAVIGATION_FAILED: ${error.message}`);
  }

  const html = await page.content();
  const body = options.text ? await page.evaluate(() => document.body.innerText) : html;
  const title = await page.title();
  const finalUrl = page.url();

  console.log(`URL:        ${url}`);
  console.log(`FINAL_URL:  ${finalUrl}`);
  console.log(`STATUS:     ${status}`);
  console.log(`BYTES:      ${body.length}`);
  console.log(`TITLE:      ${title}`);
  console.log(`VERDICT:    ${verdictFor(status, html, title, finalUrl, url)}`);
  console.log(`RETRIEVED:  ${new Date().toISOString()}`);

  if (outputPath) {
    fs.writeFileSync(outputPath, body);
    console.log(`SAVED:      ${outputPath}`);
  }

  await context.close();
  const browser = context.browser();
  if (browser) await browser.close();
})();
