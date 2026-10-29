// スプレッドシートの「WS公開用」タブ（ウェブに公開したCSV）を取得し、ワークショップ一覧のページが読む
// workshop.json と、小さくした写真（photos/）を出力先フォルダーに書く。
//
// 使い方: node scripts/workshop.mjs <出力先フォルダー>
//   環境変数 WS_CSV_URL  … 公開CSVのURL（GitHub の Secret）
//            WS_CSV_FILE … URLの代わりに手元のCSVファイルを読む（テスト用）
//            PAGES_URL   … 配信中のデータの置き場所（前回との比較と、作り済みの写真の使い回しに使う）
//            FORCE       … 'true' なら、CSVが前回と同じでも作り直す（手動実行）
// 見出しが足りない・件数が前回の半分未満になったなどの異常があれば、何も書かずに失敗で終わる
// （その場合は配信されず、前回のデータがそのまま残る）。
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const outDir = process.argv[2];
if (!outDir) fail('出力先フォルダーを指定してください');

// WS公開用タブの見出し（spreadsheet.md の数式と同じ）。見出しは完全一致（全角/半角・空白の違いは無視）
const FIELDS = {
  booth: 'ブース番号', name: '出展名', en: '出展名（英語）', day: '出展日', genre: 'ジャンル', sub: 'サブジャンル',
  dur: '所要時間', price: '料金', desc: '説明', about: '私たちについて', content: '出展内容について',
  hp: 'HPアドレス', sns1: 'SNS1(URL)', sns2: 'SNS2(URL)',
  photo: '写真（差し替え）', img1: '画像1リンク', img2: '画像2リンク', img3: '画像3リンク', img4: '画像4リンク',
};
const MIN_RATIO = 0.5;          // 前回の件数からこれ未満の割合に減ったら、シートの事故とみなして配信しない
const PHOTO_MAX = 960;          // 写真の長い辺（px）。一覧は2〜4列、詳細はスマホの幅いっぱい
const PHOTO_QUALITY = 78;

const csvText = await loadCsv();
const sourceHash = sha1(csvText);
const prev = await fetchJson(process.env.PAGES_URL && process.env.PAGES_URL + 'workshop.json?t=' + Date.now());
const force = process.env.FORCE === 'true' || !process.env.GITHUB_ACTIONS;
const changed = !prev || prev.sourceHash !== sourceHash;
if (!changed && !force) {
  await report([`## ワークショップ`, `- 前回からの変更: なし（配信しない）`]);
  await output('changed', 'false');
  process.exit(0);
}

const { items, rows, rejectedUrls } = parseCSV(csvText);
if (!items.length) fail('ブース番号の入った行が1件もありません');
const prevCount = prev && Array.isArray(prev.items) ? prev.items.length : 0;
if (prevCount && items.length < prevCount * MIN_RATIO) {
  fail(`ワークショップの件数が前回の ${prevCount} 件から ${items.length} 件に減りました（${MIN_RATIO * 100}% 未満）。シートを確認してください`);
}

// 写真：元の画像を取って小さな JPEG にする。前回の配信に同じ写真があれば、それを使い回す
await mkdir(join(outDir, 'photos'), { recursive: true });
const photoStats = { made: 0, reused: 0, failed: [] };
await runLimited(items.flatMap(it => it.photoSrc.map(src => ({ it, src }))), 4, async ({ it, src }) => {
  const file = 'photos/' + sha1(src).slice(0, 16) + '.jpg';
  try {
    let jpg = await fetchBuffer(process.env.PAGES_URL && process.env.PAGES_URL + file);
    if (jpg) photoStats.reused++;
    else { jpg = await makePhoto(src); photoStats.made++; }
    await writeFile(join(outDir, file), jpg);
    it.photoOk.set(src, file);
  } catch (e) {
    photoStats.failed.push(`${it.label}（${e.message}）`);
  }
});
for (const it of items) {
  it.photos = it.photoSrc.map(src => it.photoOk.get(src)).filter(Boolean);
  delete it.photoSrc; delete it.photoOk;
}

const generatedAt = new Date().toISOString();
await writeFile(join(outDir, 'workshop.json'), JSON.stringify({ generatedAt, sourceHash, count: items.length, items }));
await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

await report([
  `## ワークショップ`,
  `- 行数（見出しを除く）: ${rows}`,
  `- ワークショップ: ${items.length} 件（前回 ${prevCount || 'なし'}）`,
  `- 前回からの変更: ${changed ? 'あり（配信する）' : 'なし（手動実行なので配信する）'}`,
  `- http(s) 以外で外したURL: ${rejectedUrls} 件`,
  `- 写真: 新しく作った ${photoStats.made} 枚・前回のものを使った ${photoStats.reused} 枚・失敗 ${photoStats.failed.length} 枚${photoStats.failed.length ? '（' + photoStats.failed.join('、') + '）' : ''}`,
]);
await output('changed', 'true');

// ---------------------------------------------------------------------------

function fail(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}
function report(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) return appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) return appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

async function loadCsv() {
  if (process.env.WS_CSV_FILE) return readFile(process.env.WS_CSV_FILE, 'utf8');
  const url = process.env.WS_CSV_URL;
  if (!url) fail('WS_CSV_URL（公開CSVのURL）が設定されていません');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`公開CSVを取得できませんでした（HTTP ${res.status}）`);
  const type = res.headers.get('content-type') || '';
  // 公開をやめた・URLが違うときは Google のHTMLページが返る
  if (!type.includes('text/csv')) fail(`公開CSVの代わりに ${type} が返りました。「ウェブに公開」の設定を確認してください`);
  return res.text();
}

async function fetchJson(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}
async function fetchBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (e) {
    return null;
  }
}

async function makePhoto(src) {
  const res = await fetch(src, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  // HEIC はそのままではブラウザでもこのライブラリでも読めないので、先に JPEG にする
  if (isHeic(buf)) buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
  return sharp(buf)
    .rotate()                                         // 撮ったときの向きに直す
    .resize({ width: PHOTO_MAX, height: PHOTO_MAX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })               // 透明のある PNG は白地にする
    .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();
}
function isHeic(buf) {
  const brand = buf.subarray(4, 12).toString('latin1');
  return brand.startsWith('ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand.slice(4));
}

async function runLimited(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i !== list.length) await fn(list[i++]);
  });
  await Promise.all(workers);
}

// ---- CSV ----

function normHeader(h) {
  return String(h || '').replace(/^﻿/, '').normalize('NFKC').replace(/\s+/g, '');
}
function isSafeUrl(u) {
  return /^https?:\/\//i.test((u || '').trim());
}
// 「D-001」「d-1」→「D-1」。ページの地図は「D-1」の形で持っている
function normBoothId(id) {
  const m = String(id || '').trim().toUpperCase().match(/^([A-Z]{1,3})-?0*(\d{1,4})$/);
  return m ? m[1] + '-' + m[2] : String(id || '').trim().toUpperCase();
}

// CSV全体を1文字ずつパースし、クォート内の改行・カンマに対応（boothfinder-data と同じ）
function parseCSVFull(text) {
  const rows = [];
  let row = [], cur = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuote = false;
      } else cur += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* CRLF対応のため無視 */ }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseCSV(text) {
  const all = parseCSVFull(text);
  const headers = (all[0] || []).map(normHeader);
  const idx = {}, missing = [];
  for (const [key, name] of Object.entries(FIELDS)) {
    const i = headers.indexOf(normHeader(name));
    if (i === -1) missing.push(name); else idx[key] = i;
  }
  if (missing.length) fail('見出しが見つかりません: ' + missing.join('、') + '\nCSVの見出し: ' + (all[0] || []).join(', ').slice(0, 500));
  const get = (row, key) => (row[idx[key]] || '').trim();

  const items = [];
  let rejectedUrls = 0;
  for (const row of all.slice(1)) {
    const boothStr = get(row, 'booth');
    if (!boothStr) continue;
    // スプレッドシートのエラー（見出しの打ち間違いなど）がそのまま公開されないよう止める
    const err = Object.keys(idx).find(k => /^#(N\/A|REF!|VALUE!|NAME\?|ERROR!|DIV\/0!)/.test(get(row, k)));
    if (err) fail(`${boothStr} の「${FIELDS[err]}」がスプレッドシートのエラー（${get(row, err)}）です。WS公開用タブを確認してください`);

    const url = (key) => {
      const v = get(row, key);
      if (v && !isSafeUrl(v)) { rejectedUrls++; return ''; }
      return v;
    };
    const booths = boothStr.split(',').map(normBoothId).filter(Boolean);
    // 表示用：「D-10,D-11」→「D-10・11」（同じ列記号が続くとき）
    const label = booths.map((b, k) => k && b.split('-')[0] === booths[0].split('-')[0] ? b.split('-')[1] : b).join('・');
    const links = [];
    for (const [key, type] of [['hp', 'hp'], ['sns1', 'sns'], ['sns2', 'sns']]) { const u = url(key); if (u) links.push({ type, url: u }); }
    const photoSrc = [...new Set([url('photo'), url('img1'), url('img2'), url('img3'), url('img4')].filter(Boolean))];

    const it = { booths, label, name: get(row, 'name') };
    for (const key of ['en', 'day', 'genre', 'sub', 'dur', 'price', 'desc', 'about', 'content']) {
      const v = get(row, key);
      if (v) it[key] = v;
    }
    if (links.length) it.links = links;
    it.photoSrc = photoSrc;
    it.photoOk = new Map();
    items.push(it);
  }
  // ブース番号の順（D-1, D-2 … D-10）。列記号、番号の順に並べる
  items.sort((a, b) => {
    const [la, na] = a.booths[0].split('-'), [lb, nb] = b.booths[0].split('-');
    return la === lb ? (+na || 0) - (+nb || 0) : la.localeCompare(lb);
  });
  return { items, rows: all.length - 1, rejectedUrls };
}
