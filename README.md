# df-event-data

This repo delivers data for the Design Festa event pages on designfesta.com. It takes data from a spreadsheet and publishes it on GitHub Pages. For now it serves the workshop list and the food list; the stage timetables may follow.

The pages themselves live in the private repo `designfesta-jp/web-design` (`event/`). This public repo holds only the fetch and conversion script and the workflow. The data is never committed; each run uploads it straight to Pages. It works the same way as `designfesta-jp/boothfinder-data`, and reads from the same spreadsheet.

## How it works
1. Every 30 minutes, GitHub Actions fetches the spreadsheet's "WS公開用" and "FOOD公開用" tabs, which are published to the web as CSV.
2. `scripts/build.mjs` converts them into `workshop.json` and `food.json`. Columns are matched by their header names, only http(s) URLs are kept, and booth numbers are written as `D-1` / `Z-1` (`D-10,D-11` becomes the label `D-10・11`). Each list's columns are set in `DATASETS` at the top of the script.
3. It downloads each photo and makes a small JPEG (longest side 960px) in `photos/`. HEIC photos are converted. A photo that was already published last time is reused instead of downloaded again.
4. It publishes the result to `https://designfesta-jp.github.io/df-event-data/workshop.json` and `.../food.json`.

## Safeguards
- **Broken input:** if a header is missing in either tab, a cell holds a spreadsheet error (`#N/A` and so on), or the count drops below half of the previous run, the run fails. Nothing is published and the previous data stays live.
- **No change:** if neither CSV has changed since last time, the run doesn't publish. If one has changed, both lists are rebuilt and published together (a deploy replaces the whole site). A manual run always publishes.
- **One broken tab blocks both:** a problem in either tab stops the whole run, so the other list doesn't update either until it's fixed.
- **Bad photos:** a photo that can't be fetched or converted is left out, and the run's summary lists it.

## Setup
- **Secrets:** `WS_CSV_URL` and `FOOD_CSV_URL` hold the published CSV URLs ("ウェブに公開", the "WS公開用" / "FOOD公開用" tab, CSV format). Settings → Secrets and variables → Actions. Both must be set, or the run fails.
- **Pages:** Settings → Pages → Source is set to "GitHub Actions".

## Adding another dataset
Pages replaces the whole site on every deploy. Add it to `DATASETS` in `scripts/build.mjs` (and its secret to the workflow) so it's written into the same `site` folder in the same run; a second workflow would wipe out the other lists' files.

## How to run it now
Actions tab → "イベントのデータを配信" → Run workflow.

To try it locally: `npm ci`, then `WS_CSV_FILE=<downloaded CSV> FOOD_CSV_FILE=<downloaded CSV> node scripts/build.mjs site`. Locally, a list with neither a file nor a URL is skipped.

## Note
GitHub disables scheduled workflows in a public repo after 60 days with no activity. Before an event, check on the Actions tab that the workflow is enabled. If it shows "disabled", turn it back on with "Enable workflow".
