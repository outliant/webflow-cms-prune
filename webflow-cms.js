#!/usr/bin/env node
/**
 * webflow-cms.js — a safe, reusable CLI for pruning Webflow CMS locale variants.
 *
 * Works on any collection in a site. Nothing is hardcoded: collections, items and
 * locales are all resolved live from the API by name / tag.
 *
 * Safety model (why this is safe to hand to a teammate):
 *   • Dry-run by default. Deletions only happen with --live.
 *   • Live deletes require typed confirmation (the collection name), unless --yes.
 *   • Every variant is backed up to ./backups/<run>/ BEFORE it is deleted.
 *   • Every operation is appended to ./logs/audit.jsonl.
 *   • The primary locale is never deletable — deleting it destroys the whole item,
 *     so an item can never be reduced below its primary variant.
 *   • Only locales an item actually has are deleted (verified first).
 *   • 429 / 5xx responses are retried with backoff + Retry-After.
 *   • The token is read from the environment only, never a CLI argument.
 *
 * Docs & examples: see README.md.  Quick help:  webflow-cms.js --help
 */

import { parseArgs } from "node:util";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";

const VERSION = "1.0.0";
const BASE = "https://api.webflow.com/v2";
const TOKEN = process.env.WEBFLOW_TOKEN;
const MAX_RETRIES = 5;
const BLAST_LIMIT = 100; // above this many deletions, require an explicit --yes

// ---- tiny helpers ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tryJSON = (t) => { try { return JSON.parse(t); } catch { return null; } };
const splitList = (arr) => (arr || []).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);

// Usage errors exit 2; everything else exits 1.
function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, "accept-version": "2.0.0", ...extra };
}

// ---- HTTP with retry -------------------------------------------------------

async function request(pathname, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${pathname}`, { ...init, headers: authHeaders(init.headers) });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw new Error(`Network error on ${init.method || "GET"} ${pathname}: ${e.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
      continue;
    }
    return { res, text };
  }
}

async function api(pathname, init = {}) {
  const { res, text } = await request(pathname, init);
  const body = text ? tryJSON(text) : null;
  if (!res.ok) {
    const msg = (body && body.message) || text || res.statusText;
    const err = new Error(`HTTP ${res.status} on ${init.method || "GET"} ${pathname}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Fetch a single locale variant without throwing on 404 (used to test presence).
async function getVariant(collectionId, itemId, cmsLocaleId) {
  const { res, text } = await request(`/collections/${collectionId}/items/${itemId}?cmsLocaleId=${cmsLocaleId}`);
  if (res.status === 404) return { present: false, status: 404 };
  if (!res.ok) return { present: false, status: res.status, error: tryJSON(text)?.message || text };
  const data = tryJSON(text);
  return { present: true, status: 200, draft: !!data?.isDraft, data };
}

// ---- resolvers -------------------------------------------------------------

async function resolveSite(sel) {
  const { sites } = await api(`/sites`);
  if (!sites.length) throw new Error("No sites are available for this token.");
  if (sel) {
    const byId = sites.find((s) => s.id === sel);
    if (byId) return byId;
    const exact = sites.find((s) => s.displayName.toLowerCase() === sel.toLowerCase());
    if (exact) return exact;
    const m = sites.filter((s) => new RegExp(escapeRe(sel), "i").test(s.displayName));
    if (m.length === 1) return m[0];
    if (m.length === 0) throw usage(`No site matching "${sel}".`);
    throw usage(`"${sel}" matches ${m.length} sites: ${m.map((s) => s.displayName).join(", ")}. Be more specific.`);
  }
  if (sites.length > 1) {
    throw usage(`Multiple sites on this token: ${sites.map((s) => s.displayName).join(", ")}. Pick one with --site.`);
  }
  return sites[0];
}

async function getLocales(siteId) {
  const site = await api(`/sites/${siteId}`);
  const raw = site.locales || {};
  const norm = (l, primary) => ({
    tag: l.tag,
    displayName: l.displayName,
    cmsLocaleId: l.cmsLocaleId || l.id,
    enabled: l.enabled,
    primary,
  });
  const primary = raw.primary ? norm(raw.primary, true) : null;
  const secondary = (raw.secondary || []).map((l) => norm(l, false));
  const all = [primary, ...secondary].filter(Boolean);
  const byTag = new Map(all.map((l) => [l.tag.toLowerCase(), l]));
  return { primary, secondary, all, byTag };
}

async function resolveCollection(siteId, sel) {
  if (!sel) throw usage("A collection is required (name substring or id) — pass it positionally or with -c.");
  const { collections } = await api(`/sites/${siteId}/collections`);
  const byId = collections.find((c) => c.id === sel);
  if (byId) return byId;
  const exact = collections.find((c) => c.displayName.toLowerCase() === sel.toLowerCase());
  if (exact) return exact;
  const m = collections.filter((c) => new RegExp(escapeRe(sel), "i").test(c.displayName));
  if (m.length === 0) throw usage(`No collection matching "${sel}". Run \`collections\` to list them.`);
  if (m.length > 1) throw usage(`"${sel}" matches ${m.length} collections: ${m.map((c) => c.displayName).join(", ")}. Be more specific or use the id.`);
  return m[0];
}

async function listAllItems(collectionId) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await api(`/collections/${collectionId}/items?limit=100&offset=${offset}`);
    out.push(...page.items);
    const total = page.pagination?.total ?? out.length;
    offset += page.items.length;
    if (offset >= total || page.items.length === 0) break;
  }
  return out;
}

function matchItems(items, selectors) {
  if (!selectors.length) return items;
  return items.filter((it) => {
    const name = it.fieldData?.name || "";
    return selectors.some((sel) => it.id === sel || name.toLowerCase().includes(sel.toLowerCase()));
  });
}

function resolveTags(locales, tags, label) {
  return splitList(tags).map((t) => {
    const l = locales.byTag.get(t.toLowerCase());
    if (!l) throw usage(`Unknown locale tag "${t}" for ${label}. Run \`locales\` to see valid tags.`);
    return l;
  });
}

// ---- backups & audit -------------------------------------------------------

async function backupVariants(runDir, site, collection, entries) {
  await mkdir(runDir, { recursive: true });
  const manifest = {
    ts: new Date().toISOString(),
    tool: `webflow-cms ${VERSION}`,
    site: { id: site.id, name: site.displayName },
    collection: { id: collection.id, name: collection.displayName },
    note: "Backups preserve variant content for manual rebuild. The Webflow API cannot re-add a deleted locale, so these are NOT auto-restorable.",
    variants: [],
  };
  for (const { item, locale, data } of entries) {
    const dir = path.join(runDir, collection.id, item.id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${locale.tag}.json`);
    await writeFile(file, JSON.stringify(data ?? null, null, 2));
    manifest.variants.push({
      item: { id: item.id, name: item.fieldData?.name },
      locale: locale.tag,
      cmsLocaleId: locale.cmsLocaleId,
      file: path.relative(runDir, file),
    });
  }
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function audit(record) {
  await mkdir("logs", { recursive: true });
  await appendFile(path.join("logs", "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), tool: `webflow-cms ${VERSION}`, ...record }) + "\n");
}

async function confirm(question, expected) {
  if (!stdin.isTTY) {
    throw usage("Refusing a live delete on a non-interactive stream without confirmation. Re-run with --yes to bypass (e.g. in CI).");
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = await rl.question(question);
    return ans.trim() === expected;
  } finally {
    rl.close();
  }
}

// ---- shared delete core (used by both flag mode and the wizard) ------------

// Probe each candidate locale per item; keep only the ones that exist, with data for backup.
async function buildDeletionPlan(collectionId, items, candidates) {
  const plan = [];
  let total = 0;
  for (const item of items) {
    const present = [];
    for (const l of candidates) {
      const p = await getVariant(collectionId, item.id, l.cmsLocaleId);
      if (p.present) present.push({ locale: l, data: p.data });
      await sleep(120);
    }
    plan.push({ item, present });
    total += present.length;
  }
  return { plan, total };
}

// Back up (unless disabled), delete, and audit. Returns per-item results; prints nothing.
async function runDeletion({ site, col, plan, backupDir, noBackup }) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(backupDir, runId);
  let backedUp = 0;
  if (!noBackup) {
    const entries = plan.flatMap(({ item, present }) => present.map((p) => ({ item, locale: p.locale, data: p.data })));
    await backupVariants(runDir, site, col, entries);
    backedUp = entries.length;
  }
  const results = [];
  let failures = 0;
  for (const { item, present } of plan) {
    if (!present.length) continue;
    const tags = present.map((p) => p.locale.tag);
    const cmsLocaleIds = present.map((p) => p.locale.cmsLocaleId);
    try {
      await api(`/collections/${col.id}/items`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: item.id, cmsLocaleIds }] }),
      });
      results.push({ name: item.fieldData?.name, tags, ok: true });
      await audit({ action: "delete", result: "ok", site: site.id, collection: col.id, item: item.id, itemName: item.fieldData?.name, locales: tags, backupDir: noBackup ? null : runDir });
    } catch (e) {
      failures++;
      results.push({ name: item.fieldData?.name, tags, ok: false, error: e.message });
      await audit({ action: "delete", result: "fail", site: site.id, collection: col.id, item: item.id, itemName: item.fieldData?.name, locales: tags, error: e.message });
    }
    await sleep(1000);
  }
  return { runDir, backedUp, results, failures };
}

// ---- commands --------------------------------------------------------------

async function cmdLocales(opts) {
  const site = await resolveSite(opts.site || process.env.WEBFLOW_SITE);
  const locales = await getLocales(site.id);
  if (opts.json) return void console.log(JSON.stringify(locales.all, null, 2));
  console.log(`Site: ${site.displayName}\n`);
  console.log(`  ${"TAG".padEnd(8)} ${"cmsLocaleId".padEnd(26)} ${"ENABLED".padEnd(8)} NAME`);
  for (const l of locales.all) {
    console.log(`  ${(l.tag || "?").padEnd(8)} ${l.cmsLocaleId.padEnd(26)} ${String(l.enabled ?? "-").padEnd(8)} ${l.displayName}${l.primary ? "  (PRIMARY)" : ""}`);
  }
}

async function cmdCollections(opts) {
  const site = await resolveSite(opts.site || process.env.WEBFLOW_SITE);
  const { collections } = await api(`/sites/${site.id}/collections`);
  if (opts.json) return void console.log(JSON.stringify(collections.map((c) => ({ id: c.id, name: c.displayName })), null, 2));
  console.log(`Site: ${site.displayName}  (${collections.length} collections)\n`);
  for (const c of collections) console.log(`  ${c.id}  ${c.displayName}`);
}

async function cmdItems(opts, positionals) {
  const site = await resolveSite(opts.site || process.env.WEBFLOW_SITE);
  const col = await resolveCollection(site.id, opts.collection || positionals[0]);
  const items = matchItems(await listAllItems(col.id), splitList(opts.items));
  if (opts.json) return void console.log(JSON.stringify(items.map((i) => ({ id: i.id, name: i.fieldData?.name, slug: i.fieldData?.slug })), null, 2));
  console.log(`Collection: ${col.displayName}  (${items.length} matched)\n`);
  for (const it of items) console.log(`  ${it.id}  ${it.fieldData?.name}`);
}

async function cmdStatus(opts, positionals) {
  const site = await resolveSite(opts.site || process.env.WEBFLOW_SITE);
  const col = await resolveCollection(site.id, opts.collection || positionals[0]);
  const locales = await getLocales(site.id);
  const items = matchItems(await listAllItems(col.id), splitList(opts.items));
  if (!items.length) throw usage("No items matched -i/--items.");

  const report = [];
  for (const it of items) {
    const row = { id: it.id, name: it.fieldData?.name, locales: {} };
    if (!opts.json) console.log(`\n=== ${it.fieldData?.name}  (${it.id}) ===`);
    for (const l of locales.all) {
      const p = await getVariant(col.id, it.id, l.cmsLocaleId);
      const state = p.present ? (p.draft ? "draft" : "PUBLISHED") : `absent (${p.status})`;
      row.locales[l.tag] = p.present ? (p.draft ? "draft" : "published") : "absent";
      if (!opts.json) console.log(`  ${p.present ? "PRESENT" : "absent "}  ${(l.tag || "?").padEnd(8)} ${state}${l.primary ? "  (primary)" : ""}`);
      await sleep(120);
    }
    report.push(row);
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
}

async function cmdDelete(opts, positionals) {
  const site = await resolveSite(opts.site || process.env.WEBFLOW_SITE);
  const col = await resolveCollection(site.id, opts.collection || positionals[0]);
  const locales = await getLocales(site.id);
  const items = matchItems(await listAllItems(col.id), splitList(opts.items));
  if (!items.length) throw usage("No items matched -i/--items. Refusing to touch an empty selection.");

  const hasKeep = splitList(opts.keep).length > 0;
  const hasLocales = splitList(opts.locales).length > 0;
  if (hasKeep === hasLocales) throw usage("Pass exactly one of -k/--keep or -l/--locales.");

  // Build the candidate deletion set.
  let candidates;
  if (hasKeep) {
    const keep = new Set(resolveTags(locales, opts.keep, "--keep").map((l) => l.tag.toLowerCase()));
    candidates = locales.secondary.filter((l) => !keep.has(l.tag.toLowerCase()));
  } else {
    candidates = resolveTags(locales, opts.locales, "--locales");
  }
  // Hard guard: the primary locale can never be deleted.
  const primaryTag = locales.primary?.tag?.toLowerCase();
  const strippedPrimary = candidates.some((l) => l.tag.toLowerCase() === primaryTag);
  candidates = candidates.filter((l) => l.tag.toLowerCase() !== primaryTag);

  const dryRun = !opts.live;

  console.log(`Collection: ${col.displayName}  (${col.id})`);
  console.log(`Items:      ${items.length}  [${items.map((i) => i.fieldData?.name).join(", ")}]`);
  console.log(`Keeping:    ${locales.primary?.tag} (primary)${hasKeep ? " + " + resolveTags(locales, opts.keep, "--keep").map((l) => l.tag).join(", ") : ""}`);
  console.log(`Candidates: ${candidates.map((l) => l.tag).join(", ") || "(none)"}`);
  if (strippedPrimary) console.log(`NOTE: primary locale removed from the deletion set (it can never be deleted).`);
  console.log(`Mode: ${dryRun ? "DRY RUN — nothing will be deleted" : "LIVE DELETE"}\n`);

  // Per-item: keep only locales the item actually has, and capture their data for backup.
  const { plan, total: totalDeletions } = await buildDeletionPlan(col.id, items, candidates);
  for (const { item, present } of plan) {
    const skipped = candidates.filter((c) => !present.some((p) => p.locale.tag === c.tag));
    console.log(`  ${item.fieldData?.name}`);
    console.log(`     will delete: ${present.map((p) => p.locale.tag).join(", ") || "(nothing — not present in any candidate locale)"}`);
    if (skipped.length) console.log(`     skipped (absent): ${skipped.map((l) => l.tag).join(", ")}`);
  }
  console.log(`\nTotal variant deletions: ${totalDeletions}`);

  if (dryRun) {
    console.log(`Backups would be written to ./${opts["backup-dir"]}/<timestamp>/ before deletion.`);
    console.log(`\nDry run only. Re-run with --live to execute.`);
    return;
  }
  if (totalDeletions === 0) {
    console.log(`\nNothing to delete.`);
    return;
  }

  // Blast-radius guard.
  if (totalDeletions > BLAST_LIMIT && !opts.yes) {
    throw usage(`Refusing to delete ${totalDeletions} variants (> ${BLAST_LIMIT}) without --yes. Re-check the selection, then pass --yes if intended.`);
  }

  // Confirmation.
  if (!opts.yes) {
    const ok = await confirm(`\nType the collection name "${col.displayName}" to confirm deleting ${totalDeletions} variant(s): `, col.displayName);
    if (!ok) { console.log("Confirmation did not match. Aborted — nothing was deleted."); process.exitCode = 1; return; }
  }

  const del = await runDeletion({ site, col, plan, backupDir: opts["backup-dir"], noBackup: opts["no-backup"] });
  console.log(opts["no-backup"] ? `\n--no-backup set: skipping backups (not recommended).` : `\nBacked up ${del.backedUp} variant(s) to ./${del.runDir}/`);
  console.log(`Deleting...`);
  for (const r of del.results) console.log(r.ok ? `  OK   ${r.name} — ${r.tags.join(", ")}` : `  FAIL ${r.name} — ${r.error}`);
  console.log(`\nDone.${del.failures ? ` ${del.failures} item(s) failed — see logs/audit.jsonl.` : ""} Verify with \`status\`, then publish in the Designer.`);
  if (del.failures) process.exitCode = 3;
}

// ---- interactive wizard (cute mode; @clack loaded lazily) ------------------

async function cmdWizard() {
  if (!stdin.isTTY) {
    console.log("Interactive mode needs a real terminal. Run a command instead — see `--help`.");
    return;
  }
  let p;
  try {
    p = await import("@clack/prompts");
  } catch {
    console.log("Interactive mode needs its dependency. Run:  npm install   (then re-run with no arguments).");
    console.log("Meanwhile every feature is available via flags — see `--help`.");
    return;
  }
  const bail = (v) => { if (p.isCancel(v)) { p.cancel("Cancelled — nothing was changed."); process.exit(0); } return v; };

  p.intro("Webflow CMS — locale prune");
  const load = p.spinner();
  load.start("Loading site, locales and collections…");
  const site = await resolveSite(process.env.WEBFLOW_SITE);
  const locales = await getLocales(site.id);
  const { collections } = await api(`/sites/${site.id}/collections`);
  load.stop(`Site: ${site.displayName}`);

  const action = bail(await p.select({
    message: "What do you want to do?",
    options: [
      { value: "delete", label: "Prune locale variants (delete)" },
      { value: "status", label: "Check where an item lives" },
      { value: "locales", label: "List locales" },
      { value: "collections", label: "List collections" },
    ],
  }));

  if (action === "locales") {
    p.note(locales.all.map((l) => `${(l.tag || "?").padEnd(8)} ${l.displayName}${l.primary ? "  (primary)" : ""}`).join("\n"), "Locales");
    return p.outro("Done.");
  }
  if (action === "collections") {
    p.note(collections.map((c) => `${c.displayName}`).join("\n"), `${collections.length} collections`);
    return p.outro("Done.");
  }

  const colId = bail(await p.select({
    message: "Which collection?",
    maxItems: 12,
    options: collections.map((c) => ({ value: c.id, label: c.displayName })),
  }));
  const col = collections.find((c) => c.id === colId);

  const filter = bail(await p.text({ message: "Filter items by name (blank = all)", placeholder: "e.g. AT Contact" }));
  const sp = p.spinner();
  sp.start("Loading items…");
  const allItems = await listAllItems(col.id);
  const matched = matchItems(allItems, splitList([filter]).length ? [filter] : []);
  sp.stop(`${matched.length} item(s) matched`);
  if (!matched.length) return p.outro("No items matched — nothing to do.");

  const itemIds = bail(await p.multiselect({
    message: "Which item(s)?  (space to toggle)",
    required: true,
    options: matched.slice(0, 200).map((i) => ({ value: i.id, label: i.fieldData?.name || i.id })),
  }));
  const items = matched.filter((i) => itemIds.includes(i.id));

  if (action === "status") {
    const s2 = p.spinner();
    s2.start("Checking locales…");
    const lines = [];
    for (const it of items) {
      lines.push(`• ${it.fieldData?.name}`);
      for (const l of locales.all) {
        const r = await getVariant(col.id, it.id, l.cmsLocaleId);
        lines.push(`    ${r.present ? "✔" : "·"} ${(l.tag || "?").padEnd(8)} ${r.present ? (r.draft ? "draft" : "published") : "absent"}`);
        await sleep(120);
      }
    }
    s2.stop("Done");
    p.note(lines.join("\n"), "Locale presence");
    return p.outro("Done.");
  }

  // delete
  const keepTags = bail(await p.multiselect({
    message: `Keep which locale(s)?  (primary ${locales.primary?.tag} is always kept)`,
    required: false,
    options: locales.secondary.map((l) => ({ value: l.tag.toLowerCase(), label: `${l.tag} — ${l.displayName}` })),
  }));
  const keep = new Set(keepTags);
  const candidates = locales.secondary.filter((l) => !keep.has(l.tag.toLowerCase()));

  const planSpin = p.spinner();
  planSpin.start("Checking which variants exist…");
  const { plan, total } = await buildDeletionPlan(col.id, items, candidates);
  planSpin.stop(`Plan ready — ${total} variant(s) to delete`);
  if (total === 0) return p.outro("Nothing to delete.");

  p.note(
    plan.map(({ item, present }) => `${item.fieldData?.name}\n  → ${present.map((x) => x.locale.tag).join(", ") || "(none)"}`).join("\n"),
    `Delete ${total} variant(s) · keep ${locales.primary?.tag}${keep.size ? ", " + [...keep].join(", ") : ""} · backup first`
  );

  const typed = bail(await p.text({
    message: `Type the collection name "${col.displayName}" to confirm`,
    validate: (v) => (v !== col.displayName ? "Doesn't match — press Esc to cancel." : undefined),
  }));
  void typed;

  const go = p.spinner();
  go.start("Backing up, then deleting…");
  const del = await runDeletion({ site, col, plan, backupDir: "backups", noBackup: false });
  go.stop(del.failures ? `Completed with ${del.failures} failure(s)` : "Done");
  p.note(`backed up ${del.backedUp} → ./${del.runDir}\ndeleted ${total - del.failures}\nlogged → logs/audit.jsonl`, "Result");
  p.outro(del.failures ? "Finished with errors — check logs/audit.jsonl." : "All done. Verify, then publish in the Designer.");
}

// ---- entry -----------------------------------------------------------------

const HELP = `webflow-cms ${VERSION} — prune Webflow CMS locale variants (any collection)

  node --env-file=.env webflow-cms.js              # interactive wizard (no args)
  node --env-file=.env webflow-cms.js <command> [options]

Commands:
  locales                              List every locale (tag + cmsLocaleId)
  collections                          List collections (id + name)
  items <collection> [-i <filter>]     List items in a collection
  status <collection> -i <sel>         Show which locales the items exist in
  delete <collection> -i <sel> (-k <tags> | -l <tags>) [--live]

Options:
  -c, --collection   collection name substring or id (or pass positionally)
  -i, --items        comma-separated item name substrings and/or ids (repeatable)
  -k, --keep         locale tags to KEEP; delete every other locale the item has
  -l, --locales      locale tags to delete explicitly
      --site         site name substring or id (or set WEBFLOW_SITE)
      --live         perform deletions (default is a dry-run preview)
  -y, --yes          skip the typed confirmation (for automation/CI)
      --no-backup    skip pre-delete backups (not recommended)
      --backup-dir   backup directory (default: backups)
      --json         machine-readable output (locales/collections/items/status)
  -h, --help

Guardrails: dry-run by default · typed confirmation before --live · every variant
backed up under ./backups/ first · audit log at ./logs/audit.jsonl · primary locale
is never deletable · only locales an item actually has are removed.

Examples:
  node --env-file=.env webflow-cms.js locales
  node --env-file=.env webflow-cms.js status Accordions -i "AT Contact"
  node --env-file=.env webflow-cms.js delete Accordions -i "AT Contact" -k de-AT
  node --env-file=.env webflow-cms.js delete Accordions -i "AT Contact" -k de-AT --live
  node --env-file=.env webflow-cms.js delete Testimonials -i "Own a gym" -k en-NZ --live
`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        collection: { type: "string", short: "c" },
        items: { type: "string", short: "i", multiple: true },
        keep: { type: "string", short: "k", multiple: true },
        locales: { type: "string", short: "l", multiple: true },
        site: { type: "string" },
        live: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        "no-backup": { type: "boolean", default: false },
        "backup-dir": { type: "string", default: "backups" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    throw usage(e.message);
  }
  const { values: opts, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (command === "help" || opts.help) { console.log(HELP); return; }
  if (!TOKEN) throw usage("Set WEBFLOW_TOKEN (put it in .env and run with --env-file=.env). See README.md.");

  if (!command) return cmdWizard(); // no command → cute interactive mode

  switch (command) {
    case "locales": return cmdLocales(opts);
    case "collections": return cmdCollections(opts);
    case "items": return cmdItems(opts, rest);
    case "status": return cmdStatus(opts, rest);
    case "delete": return cmdDelete(opts, rest);
    default: throw usage(`Unknown command "${command}". Run \`webflow-cms.js --help\`.`);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(e.usage ? 2 : 1);
});
