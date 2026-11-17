# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal tool, not affiliated with the game, that suggests tags (« étiquettes ») for the cards of a WikiMasters collection (wiki-masters.com, a card game built from French Wikipedia articles). Two forms share one classification logic:

- **Chrome extension** (`extension/`, the main tool, Manifest V3): reads the site's DOM, pages through the collection, highlights cards to tag, and on request tags the whole collection, sells untagged cards, and auto-advances pack openings.
- **Python CLI** (`wmtag/`): parses text the user pastes from the Collection page into `input/*.txt` and writes reports to `output/`.

User-facing text, comments, config and output are in **French**: keep it that way. Python 3.11+ (`tomllib`), vanilla JS, no build step, no dependencies.

Public GitHub repo `Luca-CS/wikimasters-tagger`: work on feature branches, PR into `main`. `input/` (pasted pages, DOM snapshots), `cache/` and `output/` are personal data and gitignored: never commit them. 
## Commands

```
python -m unittest -v                                   # all tests, incl. JS/Python parity and node --test suites (needs node)
python -m unittest tests.test_wmtag.TestClassify.test_rules   # single test
python extension/tests/harness/run.py [filter]          # browser harness, headless Edge/Chrome (~13 min for all); PYTHONUTF8=1 on Windows
python extension/build_defaults.py                      # regenerate extension/lib/defaults.js from rules.toml/themes.toml/config.toml
node --check extension/content/content.js               # quick syntax check
node --test extension/tests/*.test.js                   # Node unit tests (packs, rhythm, store, market, strategy, backtest)
node market/backtest.js [collecte.json] > output/backtest-marche.md   # market backtest
node market/watch.js [--loop] [--target 1000]           # market collection watcher
python -m wmtag [--wikidata|--no-wikidata] [--no-open] [--min-count N] [--input DIR] [--output DIR]
```

- `lib/defaults.js` is generated: edit the TOML files, then rerun `build_defaults.py`.
- Harness pages are rebuilt from the user's real exports in `input/` (recognised by content); scenarios whose page is missing are **skipped**, not failed. Set `WMT_BROWSER` to force a browser.
- Tests must never hit the network: the end-to-end test passes `--no-wikidata --no-open`, Wikidata tests mock `_get`.
- Trying the extension: `chrome://extensions` → developer mode → "Load unpacked" on `extension/`. After an edit, reload it there **and** reload the WikiMasters tab (content scripts are not re-injected; an orphaned old script detects `chrome.runtime.id` loss and asks for F5).
- On this Windows machine, Git Bash heredocs turn `\\` into `\` and once corrupted `rules.toml`: edit TOML patterns with the editor or a script file.

## Scope rules for in-game actions

The extension acts in the game only in the ways the user explicitly asked for, and only when they start it:

- **Auto-tagging** (« Étiqueter toute la collection »): applies every suggested tag that already exists in the game (read from the « Appliquer une étiquette » dialog). It never creates tags; missing ones are skipped and listed.
- **Sale** (« Vendre les cartes sans étiquette… », confirmed once in the panel): sets the filters « Sans étiquette » + chosen rarities, then per page « Tout sélectionner (page) », deselects favourites/shiny (`sellKeep`), « Défausser (+N) » and the site's confirmation; sold cards vanish and the next move up, so it resells the same page and only turns the page when it holds only kept cards. Safeguards: every visible card must be untagged and of a chosen rarity, and the confirmation count must equal the cards to sell, otherwise nothing is sold and the run stops. Filters are restored afterwards. « Défausser » is never clicked outside this flow.
- **Packs:** auto-advance through a reveal, and a chain started only by the user's own trusted press on « Ouvrir », limited to the stock shown at that moment.

Never: interact with the « je ne suis pas un robot » check, touch trades, bid/list/reprice on the market (it is only read, see below), open packs on a timer or by watching the stock. Automation pauses while a site popup is shown, stops on trusted input outside the panel, and stops for good on « Sanction active » or an opening error matching bots/automation/blocking (`REFUSAL`). Any change to these rules needs the user's explicit decision, recorded here.

Besides wiki-masters.com itself, the only network call is the optional Wikidata enrichment; the contact e-mail for its `Api-User-Agent` lives only in the extension settings, never in `defaults.js`.

## Classification (shared)

`wmtag/classify.py` and `extension/lib/core.js` are a faithful port of each other; `TestExtensionParity` runs `extension/tests/run_core.js` under node on the same cards and asserts identical results. **Change both sides together.**

- Text is compared after `norm()` (lowercase, accents stripped, `œ`→`oe`, apostrophes unified). Patterns are normalised and wrapped for whole-word matching (`(?<![\w])(?:…)(?![\w])`; in JS `[\p{L}\p{N}_]` with `u`, ASCII fallback). Lookbehinds must stay fixed-width for Python.
- Own clues: `keywords` match the description or the title's trailing parenthesised qualifier; `title_keywords` / `titleKeywords` match the whole title. Wikidata only completes: if any rule has an own clue, Wikidata-only matches are dropped; without own clues and with a description, only Wikidata nature (P31) is used, not occupations. Score = distinct hits, ties keep rule order.
- **Active rules** (`rules.toml`) are the only tags suggested. **Candidate themes** (`themes.toml`) are only counted on untagged, unmatched cards to propose new tags past `min_count`.
- `shiny = true` rule (`Shiny`) has no keywords and matches every shiny card. `suggest()` returns categories only if the card has no category tag yet, plus Shiny on a shiny card lacking it; Shiny alone doesn't classify a card.
- `cross = true` rules are transversal tags (only `Plateau de Saclay`, 0.7.1): matched on own clues only (never Wikidata), listed after categories and before Shiny, suggested even on classified cards, left out of `agreement()`. `shiny_names()` / `shinyNames()` return shiny and cross names. Card descriptions rarely say « Saclay », so the rule relies on anchored titles (`^orsay( \(essonne\))?$`, not `orsay`, which would match « Musée d'Orsay »).
- `agreement()` measures how well rules reproduce manual tags; the CLI e2e test expects `16/16` on `tests/sample_page.txt`, so editing `rules.toml` can break tests.
- Tag names must match the in-game names exactly. The game's « Gérer les étiquettes… » dialog (last option of the tag filter) creates, renames and deletes tags: a tag renamed there must be renamed in the rules too. `Mythologie` deliberately covers all of Antiquity. Some patterns are avoided on purpose because of false positives (`electron\w*` → « électronique », `audit`/`investi\w*`, `loi de`): check `rules.toml` comments and dump matched/unmatched cards before changing patterns.

## Extension architecture

Classic scripts attach to a global `WMT` namespace (no ES modules) so the same files load in content scripts, extension pages, the service worker (`importScripts`) and Node tests.

- `lib/dom.js` is the **only** file that knows the site's markup. It relies on structure and text (h3 titles, rarity badge leaves `L|UR|SR|R|PC|C`, `div.shiny-badge`, leaf « Page X / Y », button labels, aria-labels) rather than Tailwind classes. Selection bar, tag dialog and discard confirmation are body-level portals. When the site changes, the user exports the page with the panel's « Exporter la page » and `dom.js` is adapted from that snapshot.
- `lib/store.js`: config in `chrome.storage.local`, migrated by `config.version` (currently 5; v4/v5 insert only the rules listed in `NEW_IN_V4` / `NEW_IN_V5` so a default rule the user deleted never comes back). Other keys: `scan`, `scanMeta`, `wd`, `done`, `lastRun`, `packs`, `packsNotified`, `tagRun`, `market`.
- `lib/packs.js`: pack stock estimate (free 10 min / pro 3 min cooldown, cap 10). `lib/rhythm.js`: log-normal AR(1) delay factor in [0.6, 1.8] for "natural" pacing. `lib/wikidata.js`: same API calls as `wmtag/wikidata.py` (no `maxlag`), same cache format `{titles, labels}`.
- `background.js`: opens `pages/report.html` / `options.html` (content scripts can't use `chrome.tabs`), schedules `chrome.alarms` (`wmt-full`, `wmt-next`, `wmt-badge`) on `packs`/`config` changes, sends Chrome notifications.
- `pages/`: `report` (Wikidata enrichment then `core.analyze`), `options` (rule/theme editors, tester, settings, import/export), `popup`. MV3 CSP: no inline scripts. `ui.css` is the shared theme.
- `content/content.js` runs on every wiki-masters.com page, polls `location.pathname` (Next.js client routing) and mounts on `/collection` or `/pulls`. Panel = Shadow DOM built with `createElement` + `adoptedStyleSheets` only (no `innerHTML`, for CSP/Trusted Types). Highlights use `data-wmt*` attributes and an appended `.wmt-flags` node, never `className` (React re-renders wipe classes). All clicks are currently `element.click()` / synthetic events; trusted input exists only in the harness.

### Collection driver (scan, auto-tag, sale)

Every action that changes the list (page turn, filter, tag applied, discard) reloads it: first ~0.5–1 s with **no sign at all** (old cards still clickable), then 2–3 s of loading (`opacity-40 pointer-events-none` grid, « Chargement… » pager with disabled buttons, « Actualisation… » in the selection bar), detected by `dom.collectionLoading()`.

- **Rule:** only read or click a collection at rest. Every reloading click goes through `reloadAfter(job, action, what, failed)`, which catches the start with a `MutationObserver` and waits for the end. Reading during the quiet delay gave stale cards; clicking during loading hit disabled buttons.
- The page total comes from a separate `/api/my-collection/stats` request that can arrive seconds after page-1 cards, so « Page X / Y » can be stale. `hasNextPage()` uses the card count first (`PAGE_SIZE` = 50), then waits up to 10 s for « Suivant ». Never use `p.total` to decide whether to continue.
- The site has only Précédent/Suivant: `turnPage()` / `goToPage()` move one page at a time. No pager = single page, unless « Sélectionner » is missing too (site failed to load the total → ask for F5).
- Auto-tag computes a per-page plan `tag -> [{pos, title}]` before applying anything (once tagged, `suggest()` stops proposing). It saves `tagRun = {next, total, at}` after each page and resumes within 24 h on the same page count. Any trusted click/key outside the panel stops tagging or selling; `leaveSelection()` always cancels an open discard confirmation, never confirms it.
- `waitVisible()` blocks scan/tag/sale while `document.hidden`.

### Packs page (`/pulls`)

- `autoReveal()` waits `delay(revealDelay, card)` per card (base × rhythm + bonus for UR/L, and the L flip animation so shiny is read correctly), captures the card, clicks next, then « Continuer » on the last card.
- The chain starts on a trusted `pointerdown` (capture phase, because the site may open on press and replace the DOM before `click`) or Enter/Space on « Ouvrir ». `chainNext()` waits for an enabled « Ouvrir », clicks, falls back to a synthetic press, and if the site still ignores it asks the user to click.
- `waitReady()` / `waitActive()` pause while `dom.blockingDialog()` (dialog role, « robot » text, or a large click-taking body-level overlay) is shown or the tab is hidden; `waitActive` only counts active time. `handsOff()` exempts clicks in site popups/portals and Escape during a pause; `SILENT_KEYS` (modifiers, media keys) never stop anything.
- Only the visible tab records `packs`, and only when its own reading changes (`packsSeen`), otherwise a stale second tab made the badge flip.

### Browser harness (`extension/tests/harness/`)

`build.py` rebuilds pages in `out/` (gitignored) from `input/` exports with the site's scripts stripped; `run.py` serves them (large `request_queue_size`, else Windows drops parallel requests and scenarios fail at random) and drives the browser only through CDP (`cdp.mjs`, real `Input.dispatchMouseEvent`/`dispatchKeyEvent`; on Windows `msedge.exe` is a launcher, so `--dump-dom` and process waits are unreliable). `collection_setup.js` simulates selection mode, filters, sale and the site's reload timings (`QUIET` 500 ms, `LOAD` 1.5 s, `STATS_LAG`): keep them realistic, shorter timings hid real bugs. Add a scenario for any new page feature.

## Market (`/marketplace`): read-only collection

Market data collection (asked for on 06/10/2026 for an academic project; Luca says the WikiMasters team allowed it by e-mail) is **read-only and off by default**. The extension never bids, lists or reprices; every bid stays Luca's own click.

- **Collector (`lib/market.js`, pure, tested):** GET requests from `background.js` with `credentials: "include"` (on a 401 it asks an open WikiMasters tab via the `marketGet` message, `/api/marketplace` paths only). Samples page 1 of `sort=recent` at most every 15 min (all L, UR, shiny, 15 % of the rest with weight `1/p`), reads each sampled auction's detail once 3–8 min after its end, then the card's `/sales`. Priority (`nextTask`): due detail > list > sales.
- **Safeguards, keep them:** the API answered `403 {"code":"automation_limit"}` to bulk reads (~110 list pages in 13 min). So: one request per `everySec` (60 s, jittered), a daily cap, active hours, 24 h pause and halved rate on a 403, full stop on a second 403 within 7 days or on « Sanction active » (`content.js` checks `dom.sanction()` every ~15 s and sends `marketStop`). Never page through the whole market.
- **Storage/export:** IndexedDB `wmt-market` (`lib/marketdb.js`); settings/state in storage key `market`; export every 3 h to `Downloads/wikimasters-marche/collecte.json` through `pages/offscreen.html` (a service worker cannot create blob URLs).
- **Strategy (`lib/strategy.js`) and tools (`market/backtest.js`, `market/watch.js`):** « starting-price snipe » decided at T−12 s on auctions without bids, valued only from the card's own sales at the same rarity; backtest and a Windows-toast watcher (state in `cache/market/`).
- **APIs:** `GET /api/marketplace?page&limit&sort&mine` (unstable pagination, ~800 listings/min), `/api/marketplace/{auctionId}` (`{auction, bids}`, also after the end), `/api/marketplace/cards/{cardId}/sales` (slow, 5–8 s), `/api/marketplace/mine` (10 concurrent sales). Rarity comes from monthly pageviews (C < 50, PC 50+, R 250+, SR 1 000+, UR 5 000+, L 20 000+). Minimum bid: starting price, else `max(ceil(1.1 × current), current + 1)`. « Défausser » gives 1 wikibidou per card (floor value). An account sanction (`admin_sanction`) blocks packs, trades and the market.

## Python CLI (`wmtag/`)

`read_cards` (line-based `parser.py`: alt line, rarity, title, optional description and tag lines, then two number lines; `Page N / M` sets the page; numeric titles like « 1954 » are valid) → `match_card` → `classement.csv` (`;`, utf-8-sig), `a_etiqueter.md`, `suggestions.md`, `rapport.html` (self-contained). On a cp1252 console `main()` reconfigures stdout with `errors="replace"`; set `PYTHONUTF8=1` for readable piped output.
