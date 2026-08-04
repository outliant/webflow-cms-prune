# webflow-cms

A safe, reusable CLI for pruning **Webflow CMS locale variants**.

Multi-locale Webflow sites often accumulate CMS items that were duplicated into
locales where they don't belong — a country-specific FAQ that shouldn't exist in
20 other markets, a testimonial meant for one region only. Removing those
variants by hand in the Designer is slow and error-prone, and the Webflow API
**cannot re-add a locale to an existing item**, so a wrong delete means rebuilding
by hand.

This tool makes that pruning fast, repeatable, and hard to get wrong.

---

## Why it's safe to run

| Guardrail | What it does |
|---|---|
| **Dry-run by default** | Nothing is deleted unless you pass `--live`. |
| **Typed confirmation** | A live delete asks you to type the collection name first (`--yes` to skip in automation). |
| **Backups before delete** | Every variant is written to `./backups/<timestamp>/` *before* it's removed, with a `manifest.json`. |
| **Audit log** | Every operation is appended to `./logs/audit.jsonl`. |
| **Primary is untouchable** | The primary locale can never be deleted — deleting it destroys the whole item — so an item can never be reduced below its primary variant. |
| **Presence-checked** | Only locales an item actually has are deleted; absent ones are skipped. |
| **Blast-radius guard** | Deleting more than 100 variants at once requires an explicit `--yes`. |
| **Resilient** | `429`/`5xx` responses are retried with exponential backoff and `Retry-After`. |
| **No secrets on the command line** | The token is read from the environment only, never a CLI argument. |

No IDs are hardcoded — collections, items, and locales are all resolved live from
the API by name and tag, so the same tool works on any collection in any site.

---

## Requirements

- **Node.js ≥ 20.6** (uses the built-in `--env-file` flag and `parseArgs`).
- A Webflow API token:
  - `CMS:read` for `locales`, `collections`, `items`, `status`
  - `CMS:write` for `delete`

## Setup

```bash
cp .env.example .env       # then paste your token after WEBFLOW_TOKEN=
npm install                # only for the interactive wizard; flag commands need no deps
```

Every command is prefixed with `node --env-file=.env webflow-cms.js` so the token
is loaded from `.env` and never touches your shell history.

## Interactive mode (wizard)

Run it with **no arguments** for a guided, arrow-key wizard — pick an action, a
collection, the item(s), and which locales to keep. It shows the plan and makes you
type the collection name before anything is deleted:

```bash
node --env-file=.env webflow-cms.js
```

The wizard is just a friendly front-end over the flag commands below — anything it
does, you can also do (and in CI, must do) with flags. It needs `npm install` for
`@clack/prompts`; **the flag commands have zero runtime dependencies** (the wizard's
dependency is loaded lazily, so flag/CI mode runs even without `node_modules`).

---

## Commands

```
locales                              List every locale (tag + cmsLocaleId)
collections                          List collections (id + name)
items <collection> [-i <filter>]     List items in a collection
status <collection> -i <sel>         Show which locales the items exist in
delete <collection> -i <sel> (-k <tags> | -l <tags>) [--live]
```

### Options

| Flag | Meaning |
|---|---|
| `-c, --collection` | Collection name substring or id (or pass it positionally). |
| `-i, --items` | Comma-separated item name substrings and/or ids (repeatable). |
| `-k, --keep` | Locale tags to **keep**; deletes every other locale the item has. |
| `-l, --locales` | Locale tags to delete **explicitly**. |
| `--site` | Site name substring or id (or set `WEBFLOW_SITE`). |
| `--live` | Perform deletions (default is a dry-run preview). |
| `-y, --yes` | Skip the typed confirmation (automation/CI). |
| `--no-backup` | Skip pre-delete backups (not recommended). |
| `--backup-dir` | Backup directory (default: `backups`). |
| `--json` | Machine-readable output for `locales`/`collections`/`items`/`status`. |
| `-h, --help` | Show help. |

Pass exactly one of `--keep` or `--locales` to `delete`.

---

## Examples

These are real prunes from the Anytime Fitness global site.

**See every locale and its `cmsLocaleId`:**

```bash
node --env-file=.env webflow-cms.js locales
```

**Check where two accordion items currently exist:**

```bash
node --env-file=.env webflow-cms.js status Accordions -i "AT Contact"
```

**Keep the two "AT Contact" accordions in de-AT only** — dry-run first, then execute:

```bash
node --env-file=.env webflow-cms.js delete Accordions -i "AT Contact" -k de-AT
node --env-file=.env webflow-cms.js delete Accordions -i "AT Contact" -k de-AT --live
```

**Keep the "Own a gym" testimonials in en-NZ only:**

```bash
node --env-file=.env webflow-cms.js delete Testimonials -i "Own a gym" -k en-NZ --live
```

**Delete specific locales explicitly** (instead of "keep these"):

```bash
node --env-file=.env webflow-cms.js delete Accordions -i "AT Contact" -l en-PH,vi-VN,zh-HK --live
```

> `--keep de-AT` keeps de-AT **and** the primary (en-US) and deletes the rest.
> The primary always stays as the item's draft base; it can't be deleted via the API.

---

## Backups & recovery

Before any live delete, each variant's full JSON is saved to:

```
backups/<timestamp>/<collectionId>/<itemId>/<locale>.json
backups/<timestamp>/manifest.json
```

⚠️ Backups let you **rebuild a variant by hand** — they are **not auto-restorable**,
because the Webflow API cannot re-add a locale to an existing item. Treat a delete
as permanent and rely on the dry-run + `status` to confirm before `--live`.

## Audit log

Every live operation appends a line to `logs/audit.jsonl`:

```json
{"ts":"2026-08-03T...","action":"delete","result":"ok","collection":"...","item":"...","locales":["en-PH","vi-VN","zh-HK"],"backupDir":"backups/..."}
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Runtime error, or confirmation mismatch. |
| `2` | Usage error (bad flags, ambiguous collection, unknown locale…). |
| `3` | Live delete completed but one or more items failed. |

---

## Recommended workflow

1. `status <collection> -i "<item>"` — see the current locale spread.
2. `delete ... -k <keep>` — read the dry-run plan carefully.
3. `delete ... -k <keep> --live` — confirm, back up, delete.
4. `status ...` again to verify, then **publish in the Designer**.
