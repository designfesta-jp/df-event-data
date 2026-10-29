# df-event-data

This repo delivers data for the Design Festa event pages on designfesta.com. It takes data from a spreadsheet and publishes it on GitHub Pages. For now it serves the workshop list; the food list and the stage timetables may follow.

The pages themselves live in the private repo `designfesta-jp/web-design` (`event/`). This public repo holds only the fetch and conversion script and the workflow. The data is never committed; each run uploads it straight to Pages. It works the same way as `designfesta-jp/boothfinder-data`, and reads from the same spreadsheet.

## How it works
1. Every 30 minutes, GitHub Actions fetches the spreadsheet's "WS公開用" tab, which is published to the web as CSV.
2. It converts the CSV into `workshop.json`. Columns are matched by their header names, only http(s) URLs are kept, and booth numbers are written as `D-1` (`D-10,D-11` becomes the label `D-10・11`).
3. It downloads each photo and makes a small JPEG (longest side 960px) in `photos/`. HEIC photos are converted. A photo that was already published last time is reused instead of downloaded again.
4. It publishes the result to `https://designfesta-jp.github.io/df-event-data/workshop.json`.

## Safeguards
- **Broken input:** if a header is missing, a cell holds a spreadsheet error (`#N/A` and so on), or the count drops below half of the previous run, the run fails. Nothing is published and the previous data stays live.
- **No change:** if the CSV hasn't changed since last time, the run doesn't publish. A manual run always publishes.
- **Bad photos:** a photo that can't be fetched or converted is left out, and the run's summary lists it.

## Setup
- **Secret:** `WS_CSV_URL` holds the published CSV URL ("ウェブに公開", "WS公開用" tab only, CSV format). Settings → Secrets and variables → Actions.
- **Pages:** Settings → Pages → Source is set to "GitHub Actions".

## Adding another dataset
Pages replaces the whole site on every deploy. Write every dataset into the same `site` folder in the same workflow; a second workflow would wipe out the first one's files.

## How to run it now
Actions tab → "イベントのデータを配信" → Run workflow.

To try it locally: `npm ci`, then `WS_CSV_FILE=<downloaded CSV> node scripts/workshop.mjs site`.

## Note
GitHub disables scheduled workflows in a public repo after 60 days with no activity. Before an event, check on the Actions tab that the workflow is enabled. If it shows "disabled", turn it back on with "Enable workflow".
