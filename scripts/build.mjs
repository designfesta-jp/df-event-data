// スプレッドシートの公開用タブ（ウェブに公開したCSV）を取得し、イベントのページが読む JSON と、
// 小さくした写真（photos/）を出力先フォルダーに書く。今はワークショップ一覧（workshop.json）・フード店舗一覧（food.json）・
// ショーステージとパフォーマンスのタイムテーブル（timetable.json）。
//
// 使い方: node scripts/build.mjs <出力先フォルダー>
//   環境変数 WS_CSV_URL・FOOD_CSV_URL・TT_CSV_URL    … 公開CSVのURL（GitHub の Secret）
//            WS_CSV_FILE・FOOD_CSV_FILE・TT_CSV_FILE … URLの代わりに手元のCSVファイルを読む（テスト用。手元ではどちらもなければその一覧は飛ばす）
//            PAGES_URL   … 配信中のデータの置き場所（前回との比較と、作り済みの写真の使い回しに使う）
//            FORCE       … 'true' なら、CSVが前回と同じでも作り直す（手動実行）
// 写真の列（写真（差し替え）・写真）には URL のほか、WordPress のメディアライブラリに上げたファイル名（例 tt64-show-sat-01）も書ける。
// 配信を作るときにメディアライブラリで探して URL にする（まだ上げていなければ、その写真なしで配信し、要約に出す）
// Pages は配信のたびにサイト全体を置き換えるので、どれか1つでも変わっていれば全部の一覧を書き出す。
// 見出しが足りない・件数が前回の半分未満になったなどの異常が1つでもあれば、何も書かずに失敗で終わる
// （その場合は配信されず、前回のデータがそのまま残る）。
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const outDir = process.argv[2];
if (!outDir) fail('出力先フォルダーを指定してください');

// 公開用タブの見出し（web-design の event/*/spreadsheet.md の数式と同じ）。見出しは完全一致（全角/半角・空白の違いは無視）
// text は JSON にそのまま入れる項目（空なら入れない）。リンク・写真はどの一覧も同じ扱い。
// ワークショップ・フードはブース番号の1行が1件、タイムテーブル（slots）はステージ・日付・開始時刻の1行が1枠
const COMMON = {
  booth: 'ブース番号', name: '出展名', en: '出展名（英語）', day: '出展日', desc: '説明',
  about: '私たちについて', content: '出展内容について', hp: 'HPアドレス', sns1: 'SNS1(URL)', sns2: 'SNS2(URL)',
  photo: '写真（差し替え）', img1: '画像1リンク', img2: '画像2リンク', img3: '画像3リンク', img4: '画像4リンク',
};
const DATASETS = [
  {
    key: 'workshop', title: 'ワークショップ', tab: 'WS公開用', urlEnv: 'WS_CSV_URL', fileEnv: 'WS_CSV_FILE',
    fields: { ...COMMON, genre: 'ジャンル', sub: 'サブジャンル', dur: '所要時間', price: '料金' },
    text: ['en', 'day', 'genre', 'sub', 'dur', 'price', 'desc', 'about', 'content'],
  },
  {
    key: 'food', title: 'フード', tab: 'FOOD公開用', urlEnv: 'FOOD_CSV_URL', fileEnv: 'FOOD_CSV_FILE',
    fields: { ...COMMON, kind: '料理', kind_en: '料理（英語）', allergy: 'アレルギー' },
    text: ['en', 'day', 'kind', 'kind_en', 'allergy', 'desc', 'about', 'content'],
  },
  {
    key: 'timetable', title: 'タイムテーブル', tab: 'TT公開用', urlEnv: 'TT_CSV_URL', fileEnv: 'TT_CSV_FILE', slots: true,
    fields: {
      stage: 'ステージ', date: '日付', start: '開始', min: '出演時間（分）', name: '出演名', en: '出演名（英語）',
      genre: 'ジャンル', genre_en: 'ジャンル（英語）', photo: '写真', desc: '紹介文', hp: 'HPアドレス', sns1: 'SNS1(URL)', sns2: 'SNS2(URL)',
    },
    text: ['en', 'genre', 'genre_en', 'desc'],
  },
];
// タイムテーブルのステージ（ステージの列の文字に含まれる語 → ページの stage）
const STAGES = [['ショー', 'show'], ['パフォーマンス', 'perf']];
const MEDIA_API = 'https://designfesta.com/wp-json/wp/v2/media';   // ファイル名で写真を探す所（WordPress の REST API）
const MEDIA_NAME = /^[A-Za-z0-9._ -]+$/;                            // ファイル名とみなす書き方（英数字・ハイフン・下線・点・空白）
const MIN_RATIO = 0.5;          // 前回の件数からこれ未満の割合に減ったら、シートの事故とみなして配信しない
const PHOTO_MAX = 960;          // 写真の長い辺（px）。一覧は2〜4列、詳細はスマホの幅いっぱい
const PHOTO_QUALITY = 78;

const force = process.env.FORCE === 'true' || !process.env.GITHUB_ACTIONS;
const sets = [];
// 先に全部の CSV を読んで確かめる（1つでも異常があれば、写真を作る前に止める）
for (const ds of DATASETS) {
  const csvText = await loadCsv(ds);
  if (csvText == null) { await report([`## ${ds.title}`, `- ${ds.fileEnv}・${ds.urlEnv} がないので飛ばした（手元での実行）`]); continue; }
  const prev = await fetchJson(process.env.PAGES_URL && process.env.PAGES_URL + ds.key + '.json?t=' + Date.now());
  sets.push({ ds, csvText, prev, ...parseCSV(csvText, ds) });
}

// 写真のファイル名を、メディアライブラリで探して URL にする。
// ファイル名が URL に変わったとき（あとから上げたとき）も配信し直すよう、前回との比較には探した結果も含める
const media = await findMedia([...new Set(sets.flatMap(s => s.items.flatMap(it => it.photoSrc)).filter(p => p.startsWith('media:')).map(p => p.slice(6)))]);
for (const s of sets) {
  const found = {};
  s.missingMedia = [];
  for (const it of s.items) {
    it.photoSrc = [...new Set(it.photoSrc.map(p => {
      if (!p.startsWith('media:')) return p;
      const name = p.slice(6);
      found[name] = media.get(name) || '';
      if (!found[name]) s.missingMedia.push(`${it.label || it.name}（${name}）`);
      return found[name];
    }).filter(Boolean))];
  }
  s.sourceHash = sha1(s.csvText + (Object.keys(found).length ? JSON.stringify(found) : ''));
  s.changed = !s.prev || s.prev.sourceHash !== s.sourceHash;
}
if (!sets.some(s => s.changed) && !force) {
  await report(sets.map(s => `- ${s.ds.title}: 前回からの変更なし`).concat('- 配信しない'));
  await output('changed', 'false');
  process.exit(0);
}

for (const s of sets) {
  const { ds } = s;
  if (!s.items.length) fail(`${ds.title}：${ds.slots ? '出演名' : 'ブース番号'}の入った行が1件もありません`);
  s.prevCount = s.prev && Array.isArray(s.prev.items) ? s.prev.items.length : 0;
  if (s.prevCount && s.items.length < s.prevCount * MIN_RATIO) {
    fail(`${ds.title}の件数が前回の ${s.prevCount} 件から ${s.items.length} 件に減りました（${MIN_RATIO * 100}% 未満）。${ds.tab}タブを確認してください`);
  }
}

// 写真：元の画像を取って小さな JPEG にする。前回の配信に同じ写真があれば、それを使い回す
await mkdir(join(outDir, 'photos'), { recursive: true });
const generatedAt = new Date().toISOString();
for (const s of sets) {
  const { ds, items } = s;
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
      photoStats.failed.push(`${it.label || it.name}（${e.message}）`);
    }
  });
  for (const it of items) {
    it.photos = it.photoSrc.map(src => it.photoOk.get(src)).filter(Boolean);
    delete it.photoSrc; delete it.photoOk;
  }

  await writeFile(join(outDir, ds.key + '.json'), JSON.stringify({ generatedAt, sourceHash: s.sourceHash, count: items.length, items }));
  await report([
    `## ${ds.title}`,
    `- 行数（見出しを除く）: ${s.rows}`,
    `- ${ds.title}: ${items.length} 件（前回 ${s.prevCount || 'なし'}）`,
    `- 前回からの変更: ${s.changed ? 'あり' : 'なし'}`,
    `- http(s) 以外で外したURL: ${s.rejectedUrls} 件`,
    `- 写真: 新しく作った ${photoStats.made} 枚・前回のものを使った ${photoStats.reused} 枚・失敗 ${photoStats.failed.length} 枚${photoStats.failed.length ? '（' + photoStats.failed.join('、') + '）' : ''}`,
    ...(s.missingMedia.length ? [`- 写真のファイル名がメディアライブラリに見つからない: ${s.missingMedia.length} 件（${s.missingMedia.join('、')}）`] : []),
  ]);
}
await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
await report([`- 配信する（${sets.some(s => s.changed) ? '変更あり' : '変更なしだが手動実行'}）`]);
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

async function loadCsv(ds) {
  if (process.env[ds.fileEnv]) return readFile(process.env[ds.fileEnv], 'utf8');
  const url = process.env[ds.urlEnv];
  if (!url) {
    if (!process.env.GITHUB_ACTIONS) return null;
    fail(`${ds.urlEnv}（${ds.tab}タブの公開CSVのURL）が設定されていません`);
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`${ds.title}の公開CSVを取得できませんでした（HTTP ${res.status}）`);
  const type = res.headers.get('content-type') || '';
  // 公開をやめた・URLが違うときは Google のHTMLページが返る
  if (!type.includes('text/csv')) fail(`${ds.title}の公開CSVの代わりに ${type} が返りました。「ウェブに公開」の設定を確認してください`);
  return res.text();
}

// メディアライブラリで、ファイル名から画像の URL を探す。見つからない名前は入らない。
// slug はファイル名と限らない（画像の中のタイトルが「Screenshot」なら screenshot-4 などになる）ので、
// 名前の頭（最初のハイフンまで。例 tt64-）で検索し、URL の末尾のファイル名（このサイトが付ける8桁の頭・-scaled・拡張子を除く）と比べる。
// 同じ名前が2つ以上あれば新しい方（検索結果は新しい順）。検索そのものができないとき（サイトが落ちているなど）は、
// 写真が消えたまま配信しないよう止める
async function findMedia(names) {
  const map = new Map();
  for (const prefix of new Set(names.map(n => n.includes('-') ? n.slice(0, n.indexOf('-') + 1) : n))) {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const res = await fetch(`${MEDIA_API}?per_page=100&page=${page}&_fields=source_url&search=${encodeURIComponent(prefix)}`, { signal: AbortSignal.timeout(30000) }).catch(e => ({ ok: false, status: e.message }));
      if (!res.ok) fail(`メディアライブラリで写真のファイル名を探せませんでした（${res.status}）。時間をおいて手動で実行してください`);
      pages = +res.headers.get('x-wp-totalpages') || 1;
      for (const m of await res.json()) {
        const name = mediaName(String(m.source_url || '').split('/').pop().replace(/^[0-9a-f]{8}-/, '').replace(/-scaled(?=\.\w+$)/, ''));
        if (isSafeUrl(m.source_url) && !map.has(name)) map.set(name, m.source_url);
      }
    }
  }
  return map;
}
// ファイル名を比べる形に（拡張子なし・小文字・空白はハイフン。WordPress も空白をハイフンにして保存する）
function mediaName(v) {
  return v.trim().replace(/\.(jpe?g|png|gif|webp|heic|pdf)$/i, '').toLowerCase().replace(/\s+/g, '-');
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

function parseCSV(text, ds) {
  const all = parseCSVFull(text);
  const headers = (all[0] || []).map(normHeader);
  const idx = {}, missing = [];
  for (const [key, name] of Object.entries(ds.fields)) {
    const i = headers.indexOf(normHeader(name));
    if (i === -1) missing.push(name); else idx[key] = i;
  }
  if (missing.length) fail(`${ds.title}：見出しが見つかりません: ` + missing.join('、') + '\nCSVの見出し: ' + (all[0] || []).join(', ').slice(0, 500));
  const get = (row, key) => (row[idx[key]] || '').trim();

  const items = [];
  let rejectedUrls = 0;
  for (const row of all.slice(1)) {
    const boothStr = get(row, ds.slots ? 'name' : 'booth');
    if (!boothStr) continue;
    // スプレッドシートのエラー（見出しの打ち間違いなど）がそのまま公開されないよう止める
    const err = Object.keys(idx).find(k => /^#(N\/A|REF!|VALUE!|NAME\?|ERROR!|DIV\/0!)/.test(get(row, k)));
    if (err) fail(`${boothStr} の「${ds.fields[err]}」がスプレッドシートのエラー（${get(row, err)}）です。${ds.tab}タブを確認してください`);

    const url = (key) => {
      const v = get(row, key);
      if (v && !isSafeUrl(v)) { rejectedUrls++; return ''; }
      return v;
    };
    // 写真の列は、URL でなく英数字のファイル名なら、メディアライブラリで探す印（media:ファイル名）にする
    const photoRef = (key) => {
      const v = get(row, key);
      return v && !isSafeUrl(v) && MEDIA_NAME.test(v) ? 'media:' + mediaName(v) : url(key);
    };
    if (ds.slots) { items.push(slotItem(ds, row, get, url, photoRef)); continue; }
    const booths = boothStr.split(',').map(normBoothId).filter(Boolean);
    // 表示用：「D-10,D-11」→「D-10・11」（同じ列記号が続くとき）
    const label = booths.map((b, k) => k && b.split('-')[0] === booths[0].split('-')[0] ? b.split('-')[1] : b).join('・');
    const links = [];
    for (const [key, type] of [['hp', 'hp'], ['sns1', 'sns'], ['sns2', 'sns']]) { const u = url(key); if (u) links.push({ type, url: u }); }
    const photoSrc = [...new Set([photoRef('photo'), url('img1'), url('img2'), url('img3'), url('img4')].filter(Boolean))];

    const it = { booths, label, name: get(row, 'name') };
    for (const key of ds.text) {
      const v = get(row, key);
      if (v) it[key] = v;
    }
    if (links.length) it.links = links;
    it.photoSrc = photoSrc;
    it.photoOk = new Map();
    items.push(it);
  }
  if (ds.slots) {
    // ステージ・日・開始時刻の順。同じ枠が2行あれば、打ち間違いとみなして止める
    const key = it => [it.stage, it.day, it.start].join(' ');
    items.sort((a, b) => key(a).localeCompare(key(b)));
    const dup = items.find((it, i) => i && key(it) === key(items[i - 1]));
    if (dup) fail(`${ds.title}：同じステージ・日・開始時刻の行が2つあります（${key(dup)}）。${ds.tab}タブを確認してください`);
    return { items, rows: all.length - 1, rejectedUrls };
  }
  // ブース番号の順（D-1, D-2 … D-10）。列記号、番号の順に並べる
  items.sort((a, b) => {
    const [la, na] = a.booths[0].split('-'), [lb, nb] = b.booths[0].split('-');
    return la === lb ? (+na || 0) - (+nb || 0) : la.localeCompare(lb);
  });
  return { items, rows: all.length - 1, rejectedUrls };
}

// タイムテーブルの1行（1枠）。ステージは show／perf、日付は曜日から sat／sun、開始は「10:10」の形にそろえる。
// 読めない値は、ページで黙って消えないよう止める
function slotItem(ds, row, get, url, photoRef) {
  const name = get(row, 'name'), where = `「${name}」の行`;
  const stageStr = get(row, 'stage');
  const stage = (STAGES.find(([w]) => stageStr.includes(w)) || [])[1];
  if (!stage) fail(`${ds.title}：${where}のステージ「${stageStr}」がわかりません（${STAGES.map(s => s[0]).join('・')}を含む文字にしてください）`);
  const dm = get(row, 'date').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  const wd = dm && new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3])).getUTCDay();
  const day = wd === 6 ? 'sat' : wd === 0 ? 'sun' : null;
  if (!day) fail(`${ds.title}：${where}の日付「${get(row, 'date')}」が土曜・日曜の日付（2026-11-14 の形）ではありません`);
  const tm = get(row, 'start').match(/^(\d{1,2})[:：](\d{2})/);
  if (!tm || +tm[1] > 23 || +tm[2] > 59) fail(`${ds.title}：${where}の開始「${get(row, 'start')}」が時刻（10:10 の形）ではありません`);
  const it = { stage, day, start: tm[1].padStart(2, '0') + ':' + tm[2], name };
  const min = parseInt(get(row, 'min'), 10);
  if (min > 0) it.min = min;
  for (const key of ds.text) {
    const v = get(row, key);
    if (v) it[key] = v;
  }
  const links = [];
  for (const [key, type] of [['hp', 'hp'], ['sns1', 'sns'], ['sns2', 'sns']]) { const u = url(key); if (u) links.push({ type, url: u }); }
  if (links.length) it.links = links;
  it.photoSrc = [photoRef('photo')].filter(Boolean);
  it.photoOk = new Map();
  return it;
}
