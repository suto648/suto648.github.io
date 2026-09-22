const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
// 差分の中核はオンライン版と共有する（lib/diff-core.js）。
// ここに書き戻さないこと。2つに分かれた瞬間に計算がずれる。
const {
  canonicalizeRichTextForDiff,
  balanceInlineTagsMultiline,
  flattenBlocks,
  blocksToSnapshot,
  computeDiff,
  normalizeDiffWhitespace,
  cleanLineForDiff,
  computeLegacyDiff
} = require('./lib/diff-core');
const { parseMarkdown } = require('./lib/md-import');
const { buildHistoryHtml } = require('./lib/history-html');
const { createStore: createProjectStore } = require('./lib/projects');

const app = express();
const PORT = Number(process.env.PORT) || 3456;

// ★オンライン版（ブラウザ）は、このファイルをそのまま読み込んで使う。
//   同じ計算を2つ書けば必ずずれるので、書き写さずに動かす。
//   そのとき「待ち受け」「ショートカット」「在席ファイル」「別PCの見張り」は
//   ブラウザに存在しない概念なので、動かさない。
//   ※ここ以外は 1 行も分岐しない。分岐が増えるほど2つの版はずれていく。
const EMBEDDED = !!(process.env && process.env.MD_EDITOR_EMBEDDED);

// データの置き場所。環境変数 MD_EDITOR_DATA があればそこ（=OneDriveの共有フォルダ）を、
// 無ければ従来どおりコードと同じ場所を使う（既存の実機はそのまま動く）。
const DATA_ROOT = process.env.MD_EDITOR_DATA || __dirname;

// 作業ファイル（プロジェクト）ごとにデータ一式を分ける。
//
// 設計: 「1つの作業ファイル = data/ + snapshots/ + daily-logs/ が入った1フォルダ」とする。
//   DATA_ROOT/data, snapshots, daily-logs        … 既定の作業ファイル（今までのデータがそのまま入っている）
//   DATA_ROOT/projects/<id>/data, snapshots, ... … あとから作った作業ファイル
//
// こうすると、履歴・本日更新・画像の仕組みを 1 行も変えずに使い回せる。
// （どれも下の4つのパスを見ているだけなので、切り替え時に中身を差し替えれば済む）
// 履歴が作業ファイルごとに分かれるのも、この分け方なら自動的に正しくなる。
//
// const ではなく let なのは、切り替えたときに参照先を差し替えるため。
// 既存のコードは 80 箇所以上でこれらを読んでいるが、読む時点の値を見るので変更は要らない。
let PROJECT_ROOT = DATA_ROOT;
let DATA_DIR = path.join(PROJECT_ROOT, 'data');
let SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'snapshots');
let DAILY_LOG_DIR = path.join(PROJECT_ROOT, 'daily-logs');
let IMAGE_DIR = path.join(DATA_DIR, 'images');
let CONTENT_FILE = path.join(DATA_DIR, 'content.json');

const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');
const PROJECTS_FILE = path.join(DATA_ROOT, 'projects.json');
const DEFAULT_PROJECT_ID = 'default';

function projectRootOf(id) {
  return id === DEFAULT_PROJECT_ID ? DATA_ROOT : path.join(PROJECTS_DIR, id);
}

let currentProjectId = DEFAULT_PROJECT_ID;

function applyProjectPaths(id) {
  currentProjectId = id;
  PROJECT_ROOT = projectRootOf(id);
  DATA_DIR = path.join(PROJECT_ROOT, 'data');
  SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'snapshots');
  DAILY_LOG_DIR = path.join(PROJECT_ROOT, 'daily-logs');
  IMAGE_DIR = path.join(DATA_DIR, 'images');
  CONTENT_FILE = path.join(DATA_DIR, 'content.json');
}
const DEFAULT_DOCUMENT_TITLE = 'やるべきこと';
const DEFAULT_AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_REDO_LIMIT = 100;
// v2: 編集中に再発する末尾単独<br>を再掃除するため再実行（v1は初回のみ実行済み）
const TRAILING_SINGLE_BR_MIGRATION_VERSION = 2;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 作業ファイル（プロジェクト）─────────────────────────────
const projectStore = createProjectStore({
  dataRoot: DATA_ROOT,
  projectsFile: PROJECTS_FILE,
  projectsDir: PROJECTS_DIR,
  defaultName: DEFAULT_DOCUMENT_TITLE
});

// 起動時に、前回開いていた作業ファイルへ戻す
applyProjectPaths(projectStore.load().currentId);

app.get('/api/projects', (req, res) => {
  res.json(projectStore.list());
});

app.post('/api/projects', (req, res) => {
  const r = projectStore.create(req.body && req.body.name);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r);
});

app.patch('/api/projects/:id', (req, res) => {
  const r = projectStore.rename(req.params.id, req.body && req.body.name);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r);
});

// 開く = これ以降の読み書きの向き先を変える。
// 画面側は、これを呼んだら必ず読み込み直すこと（別の作業ファイルの内容を
// 前の画面に上書き保存してしまわないように）。
app.post('/api/projects/:id/open', (req, res) => {
  const r = projectStore.open(req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  applyProjectPaths(r.id);
  ensureDirs();
  res.json({ ok: true, id: r.id, ...projectStore.list() });
});

app.delete('/api/projects/:id', (req, res) => {
  const r = projectStore.remove(req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (currentProjectId === req.params.id) {
    applyProjectPaths(r.nextId);
    ensureDirs();
  }
  res.json(r);
});
// Externalized images (base64 of past-day images is moved out of content.json).
app.use('/images', express.static(IMAGE_DIR));

// --- Helpers ---

function ensureDirs() {
  for (const dir of [DATA_DIR, SNAPSHOT_DIR, DAILY_LOG_DIR, IMAGE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// === 2台のPCで同じOneDriveデータを共有して使うための仕組み ===
// OneDriveは「同じファイル」への同時書き込みをマージできず競合コピーを作る。
// そこで“1つのロックを奪い合う”のはやめ、各PCが自分専用の在席ファイル
// (presence-<PC名>.json) だけを書く。別々のファイルなので競合コピーは
// 原理的に発生しない。生存は heartbeat で伝え、別PCの更新はクライアントが
// content.json の版(mtime+size)を監視して自動反映する。
const HOSTNAME = os.hostname();
const SAFE_HOST = (HOSTNAME || 'PC').replace(/[^A-Za-z0-9_-]/g, '_') || 'PC';
const PRESENCE_FILE = path.join(DATA_DIR, `presence-${SAFE_HOST}.json`);
const PRESENCE_STALE_MS = 3 * 60 * 1000;   // heartbeatがこの時間内なら「在席中」
const PRESENCE_HEARTBEAT_MS = 45 * 1000;   // 自分の在席ファイルの更新間隔
let presenceTimer = null;

function writePresence() {
  try {
    ensureDirs();
    fs.writeFileSync(PRESENCE_FILE, JSON.stringify({
      hostname: HOSTNAME,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: Date.now(),
    }), 'utf-8');
  } catch (_) {}
}

function releasePresence() {
  try { if (fs.existsSync(PRESENCE_FILE)) fs.unlinkSync(PRESENCE_FILE); } catch (_) {}
}

// 旧方式(EDITOR-LOCK*.json)の置き土産と、その競合コピーを掃除する。
function cleanupOldLockFiles() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (/^EDITOR-LOCK.*\.json$/i.test(f)) {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

// 在席中の「別PC」一覧（heartbeatが新しいものだけ）
function listOtherPresence() {
  const others = [];
  try {
    if (!fs.existsSync(DATA_DIR)) return others;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^presence-.+\.json$/.test(f)) continue;
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')); } catch (_) { continue; }
      if (!obj || obj.hostname === HOSTNAME) continue;
      const age = Date.now() - (obj.heartbeatAt || 0);
      if (age >= 0 && age < PRESENCE_STALE_MS) {
        others.push({ hostname: obj.hostname, ageSec: Math.round(age / 1000) });
      }
    }
  } catch (_) {}
  return others;
}

// content.json の版トークン（別PCの更新検知用）。中身は読まず mtime+size で軽く判定。
function contentVersion() {
  try {
    const st = fs.statSync(CONTENT_FILE);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch (_) { return '0'; }
}

// OneDriveが作る競合コピー等、想定外のファイルを検出する（削除はしない）。
// content.json.bak / .tmp（アトミック書き込みの副産物）や presence-*.json は正常。
function scanForConflicts() {
  const IGNORE = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store']);
  const checks = [
    { dir: SNAPSHOT_DIR, ok: [/^\d{8}\.json(\.(bak|tmp))?$/] },
    { dir: DAILY_LOG_DIR, ok: [
      /^\d{8}\.json(\.(bak|tmp))?$/,
      /^\d{8}\.baseline$/,
      /^\d{8}\.baseline-blocks\.json(\.(bak|tmp))?$/,
      /^\d{8}\.reorg-anchor$/,
      /^\d{8}\.baseline-reorg$/,
    ] },
    { dir: DATA_DIR, ok: [
      /^content\.json(\.(bak|tmp))?$/,
      /^reorg-state\.json(\.(bak|tmp))?$/,
      /^presence-.+\.json$/,
      /^images$/,
    ] },
  ];
  const suspicious = [];
  for (const { dir, ok } of checks) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (IGNORE.has(f)) continue;
      if (!ok.some((re) => re.test(f))) suspicious.push(path.join(path.basename(dir), f));
    }
  }
  return suspicious;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    // Primary file is corrupt (e.g. truncated by a crash mid-write).
    // Fall back to the previous-generation backup if it parses cleanly.
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try {
        const recovered = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
        console.error(`[recover] ${path.basename(filePath)} was corrupt; restored from .bak`);
        return recovered;
      } catch (_) { /* backup also unreadable — fall through to rethrow */ }
    }
    throw err;
  }
}

function writeJSON(filePath, data) {
  // Atomic write: write to a temp file then rename (rename is ~atomic on a
  // single volume), so a crash mid-write cannot leave a truncated target file.
  // Keep one previous generation as .bak for crash recovery in readJSON().
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) { /* best-effort backup */ }
  }
  fs.renameSync(tmpPath, filePath);
}

function normalizeNonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function createDefaultAppConfig(baseTitle) {
  const title = normalizeNonEmptyString(baseTitle, DEFAULT_DOCUMENT_TITLE);
  return {
    displayTitle: title,
    documentTitle: title,
    autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
    redoLimit: DEFAULT_REDO_LIMIT
  };
}

function defaultContent() {
  const appConfig = createDefaultAppConfig();
  return {
    title: appConfig.documentTitle,
    lastModified: new Date().toISOString(),
    blocks: [],
    stickyNotes: [],
    appConfig,
    trailingSingleBrMigrationVersion: TRAILING_SINGLE_BR_MIGRATION_VERSION
  };
}

function normalizeStoredContent(rawContent) {
  const source = rawContent && typeof rawContent === 'object' ? rawContent : {};
  const legacyTitle = normalizeNonEmptyString(source.title, DEFAULT_DOCUMENT_TITLE);
  const sourceAppConfig = source.appConfig && typeof source.appConfig === 'object' ? source.appConfig : {};
  const appConfig = {
    displayTitle: normalizeNonEmptyString(sourceAppConfig.displayTitle, legacyTitle),
    documentTitle: normalizeNonEmptyString(sourceAppConfig.documentTitle, legacyTitle),
    autosaveIntervalMs: normalizePositiveInteger(sourceAppConfig.autosaveIntervalMs, DEFAULT_AUTOSAVE_INTERVAL_MS),
    redoLimit: normalizePositiveInteger(sourceAppConfig.redoLimit, DEFAULT_REDO_LIMIT)
  };

  return {
    ...source,
    title: appConfig.documentTitle,
    lastModified: typeof source.lastModified === 'string' ? source.lastModified : new Date().toISOString(),
    blocks: Array.isArray(source.blocks) ? source.blocks : [],
    stickyNotes: Array.isArray(source.stickyNotes) ? source.stickyNotes : [],
    appConfig
  };
}

function stripSingleTrailingBrArtifact(text) {
  if (typeof text !== 'string' || !/<br>\s*$/i.test(text)) return text;
  if (/(<br>\s*){2,}$/i.test(text)) return text;
  return text.replace(/<br>\s*$/i, '');
}

function migrateLegacySingleTrailingBrBlocks(blocks, state) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(block => {
    if (!block || typeof block !== 'object') return block;

    const nextBlock = { ...block };
    if (nextBlock.type === 'heading' || nextBlock.type === 'paragraph') {
      const nextText = stripSingleTrailingBrArtifact(nextBlock.text);
      if (nextText !== nextBlock.text) {
        nextBlock.text = nextText;
        state.changed = true;
      }
      return nextBlock;
    }

    if (nextBlock.type === 'section' && Array.isArray(nextBlock.children)) {
      nextBlock.children = migrateLegacySingleTrailingBrBlocks(nextBlock.children, state);
    }

    return nextBlock;
  });
}

function migrateLegacySingleTrailingBrArtifacts(contentObj) {
  const normalized = normalizeStoredContent(contentObj);
  if ((normalized.trailingSingleBrMigrationVersion || 0) >= TRAILING_SINGLE_BR_MIGRATION_VERSION) {
    return { content: normalized, changed: false };
  }

  const state = { changed: false };
  const nextContent = {
    ...normalized,
    blocks: migrateLegacySingleTrailingBrBlocks(normalized.blocks, state),
    trailingSingleBrMigrationVersion: TRAILING_SINGLE_BR_MIGRATION_VERSION
  };

  return {
    content: nextContent,
    changed: state.changed || normalized.trailingSingleBrMigrationVersion !== TRAILING_SINGLE_BR_MIGRATION_VERSION
  };
}

function parseSaveRequestBody(body) {
  const source = body && typeof body === 'object' ? body : {};
  const rawContent = source.content && typeof source.content === 'object' ? source.content : body;
  const rawUndoSnapshot = source.undoSnapshot && typeof source.undoSnapshot === 'object' ? source.undoSnapshot : null;

  return {
    content: normalizeStoredContent(rawContent),
    undoSnapshot: rawUndoSnapshot ? normalizeStoredContent(rawUndoSnapshot) : null
  };
}

function escapeHtmlServer(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}



// Single-line version (kept for potential standalone use)
function balanceInlineTags(line) {
  return balanceInlineTagsMultiline([line])[0];
}

// --- Undo / Redo history ---
const undoStack = [];
const redoStack = [];

function getHistoryLimit(contentObj) {
  return normalizeStoredContent(contentObj).appConfig.redoLimit;
}

function pushHistoryEntry(stack, contentObj) {
  const normalized = normalizeStoredContent(contentObj);
  stack.push(JSON.stringify(normalized));
  const historyLimit = normalized.appConfig.redoLimit;
  if (stack.length > historyLimit) stack.splice(0, stack.length - historyLimit);
}

function pushUndo(contentObj) {
  pushHistoryEntry(undoStack, contentObj);
  redoStack.length = 0; // clear redo on new edit
}


// --- Flatten blocks for diff ---



// --- Image externalization ---
// Same-day images stay embedded as base64 so a report shared on the day it was
// written is fully self-contained. Once a day has passed they are written out to
// data/images/ and the block keeps only a "/images/<id>.<ext>" reference, so
// content.json stays small and every save stops rewriting the image bytes.

const DATA_URL_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg', bmp: 'bmp' };

function parseImageDataUrl(src) {
  if (typeof src !== 'string') return null;
  const m = src.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return null;
  const ext = DATA_URL_EXT[m[1].toLowerCase()] || 'png';
  return { ext, buffer: Buffer.from(m[2], 'base64') };
}

function externalizeImageBlock(block, todayStr) {
  // Returns true if the block was modified.
  if (!block || block.type !== 'image') return false;
  if (block.addedDate && String(block.addedDate) >= todayStr) return false; // keep today's embedded
  const parsed = parseImageDataUrl(block.src);
  if (!parsed) return false; // already a reference, or not a data URL
  try {
    if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const fileName = `${block.id}.${parsed.ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, fileName), parsed.buffer);
    block.src = `/images/${fileName}`;
    return true;
  } catch (_) {
    return false; // on any failure keep the embedded base64 — never lose the image
  }
}

function externalizeOldImages(contentObj) {
  if (!contentObj || !Array.isArray(contentObj.blocks)) return { content: contentObj, changed: false };
  const todayStr = today();
  let changed = false;
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b && b.type === 'section' && Array.isArray(b.children)) walk(b.children);
      else if (externalizeImageBlock(b, todayStr)) changed = true;
    }
  };
  walk(contentObj.blocks);
  return { content: contentObj, changed };
}

// For export: turn a "/images/<file>" reference back into an inline data URL so
// the distributed single-file HTML stays self-contained even for past images.
function resolveImageSrcForExport(src) {
  if (typeof src !== 'string' || !src.startsWith('/images/')) return src || '';
  try {
    const fileName = path.basename(src);
    const buf = fs.readFileSync(path.join(IMAGE_DIR, fileName));
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return src; // file missing — leave the reference rather than break export
  }
}

// 履歴の [画像#id] を、現在の content.json に依存せず IMAGE_DIR の実体だけから
// 復元する。外部化済み画像は "<id>.<ext>" で保存されているので、id からファイルを
// 総当たりで探して data URL 化する。見つからなければ null。
// これにより「後で削除・整理された画像」でも履歴には残せる（履歴が現在の状態から独立）。
const IMAGE_FILE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
function readImageFileById(id) {
  if (!id) return null;
  for (const ext of IMAGE_FILE_EXTS) {
    const p = path.join(IMAGE_DIR, `${id}.${ext}`);
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p); // OneDriveのオンデマンド実体はここで自動取得される
      const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch (_) { /* 読めない ext は次へ */ }
  }
  return null;
}

// 画像ブロックの実体を IMAGE_DIR に "<id>.<ext>" として永続化する（書き込みスルー）。
// content 側の src は変えない（当日画像はインラインのまま＝当日エクスポートは自己完結）。
// 既にファイルがあれば何もしない。これで「貼ってすぐ消した画像」でも履歴に残る。
function persistImageBytes(block) {
  if (!block || block.type !== 'image' || !block.id) return;
  const parsed = parseImageDataUrl(block.src);
  if (!parsed) return; // 既に参照(/images/...)＝実体は外部化済みなので不要
  try {
    if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const file = path.join(IMAGE_DIR, `${block.id}.${parsed.ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, parsed.buffer);
  } catch (_) { /* 失敗してもインラインbase64は残るので画像は失われない */ }
}

// content 全体を歩いて画像ブロックを永続化する（保存時に呼ぶ）。
function persistAllImages(contentObj) {
  if (!contentObj || !Array.isArray(contentObj.blocks)) return;
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b && b.type === 'section' && Array.isArray(b.children)) walk(b.children);
      else persistImageBytes(b);
    }
  };
  walk(contentObj.blocks);
}

// 画像ブロックをIDで再帰的に探す（本日更新/エクスポートの [画像#id] 解決用）。
function findImageBlockById(blocks, id) {
  if (!Array.isArray(blocks) || !id) return null;
  for (const b of blocks) {
    if (b && b.id === id && b.type === 'image') return b;
    if (b && b.type === 'section' && Array.isArray(b.children)) {
      const found = findImageBlockById(b.children, id);
      if (found) return found;
    }
  }
  return null;
}

// --- API Routes ---

// Load content
app.get('/api/content', (req, res) => {
  ensureDirs();
  let content = readJSON(CONTENT_FILE);
  if (!content) {
    content = defaultContent();
    writeJSON(CONTENT_FILE, content);
  } else {
    const migration = migrateLegacySingleTrailingBrArtifacts(content);
    content = migration.content;
    const imageMigration = externalizeOldImages(content);
    content = imageMigration.content;
    if (migration.changed || imageMigration.changed) writeJSON(CONTENT_FILE, content);
    // 現存する全画像の実体を IMAGE_DIR に確保（デプロイ直後の読み込みで既存画像も
    // 永続化され、以後メモから削除しても履歴に残せる）。content は変更しない。
    persistAllImages(content);
  }
  res.json(content);
});

// Save content
app.put('/api/content', (req, res) => {
  ensureDirs();

  const parsed = parseSaveRequestBody(req.body);
  const contentMigration = migrateLegacySingleTrailingBrArtifacts(parsed.content);
  const undoMigration = parsed.undoSnapshot
    ? migrateLegacySingleTrailingBrArtifacts(parsed.undoSnapshot)
    : { content: null };
  const content = contentMigration.content;
  const undoSnapshot = undoMigration.content;

  // Sanity check: reject if Japanese text was corrupted (e.g. PowerShell encoding issue)
  const json = JSON.stringify(content);
  const prevRaw = readJSON(CONTENT_FILE);
  const prev = prevRaw ? normalizeStoredContent(prevRaw) : null;
  if (prev) {
    const prevJson = JSON.stringify(prev);
    const prevJP = (prevJson.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
    const newJP = (json.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
    // If previous had significant Japanese but new has much less, likely corrupted
    if (prevJP > 50 && newJP < prevJP * 0.5) {
      return res.status(400).json({
        error: 'データ破損の疑い: 日本語文字が大幅に減少しています。保存を拒否しました。',
        prevJapanese: prevJP,
        newJapanese: newJP
      });
    }
  }

  // Push current state to undo stack before overwriting
  if (undoSnapshot) pushUndo(undoSnapshot);
  else if (prev) pushUndo(prev);

  content.lastModified = new Date().toISOString();
  writeJSON(CONTENT_FILE, content);

  // 画像の実体を IMAGE_DIR に書き込みスルー（当日画像もすぐ永続化）。
  // これで履歴の [画像#id] は現在の content に依存せず実体だけで復元でき、
  // 貼ってすぐ整理・削除した画像でも履歴に残る。src は変えない（当日はインライン維持）。
  persistAllImages(content);

  // Auto-snapshot (JSON): create if not existing for today
  const snapshotFile = path.join(SNAPSHOT_DIR, `${today()}.json`);
  if (!fs.existsSync(snapshotFile)) {
    writeJSON(snapshotFile, content);
  }

  // Auto-create legacy .snapshot: only create if not existing (preserve md-watcher format)
  // md-watcher creates snapshots in its own format; overwriting would cause format mismatch
  if (fs.existsSync(LEGACY_SNAPSHOT_DIR)) {
    try {
      const legacyFile = path.join(LEGACY_SNAPSHOT_DIR, `${today()}.snapshot`);
      if (!fs.existsSync(legacyFile)) {
        const lines = blocksToSnapshot(content.blocks);
        fs.writeFileSync(legacyFile, lines.join('\n'), 'utf-8');
      }
    } catch (_) { /* legacy dir might not be accessible, ignore */ }
  }

  // Save today's daily log (本日更新セクション as-is)
  saveDailyLog();

  res.json({ ok: true, saved: new Date().toISOString() });
});

// Undo
app.post('/api/undo', (req, res) => {
  if (undoStack.length === 0) return res.json({ ok: false, reason: 'nothing to undo' });
  ensureDirs();
  const currentRaw = readJSON(CONTENT_FILE);
  const current = currentRaw ? normalizeStoredContent(currentRaw) : null;
  if (current) pushHistoryEntry(redoStack, current);
  const prev = normalizeStoredContent(JSON.parse(undoStack.pop()));
  prev.lastModified = new Date().toISOString();
  writeJSON(CONTENT_FILE, prev);
  res.json({ ok: true, content: prev, undoLen: undoStack.length, redoLen: redoStack.length });
});

// Redo
app.post('/api/redo', (req, res) => {
  if (redoStack.length === 0) return res.json({ ok: false, reason: 'nothing to redo' });
  ensureDirs();
  const currentRaw = readJSON(CONTENT_FILE);
  const current = currentRaw ? normalizeStoredContent(currentRaw) : null;
  if (current) pushHistoryEntry(undoStack, current);
  const next = normalizeStoredContent(JSON.parse(redoStack.pop()));
  next.lastModified = new Date().toISOString();
  writeJSON(CONTENT_FILE, next);
  res.json({ ok: true, content: next, undoLen: undoStack.length, redoLen: redoStack.length });
});

// Undo/Redo stack status
// このポートに居るのが「このアプリ」かどうかを確かめるための口。
// 二重起動の判定に使う。他のAPIの形が変わっても影響を受けないよう、専用に分けてある。
// ★この応答の形は変えないこと（起動時の判定が壊れる）。
// ★機械可読の契約。app と api は形を変えないこと。
//   version は後から足したもの（追加は安全・既存の判定を壊さない）。
//   更新のお知らせ機能が、自分の版を知るために使う。
let APP_VERSION = '0.0.0';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
} catch (_) { /* 版が読めなくても本体は動く */ }

app.get('/api/whoami', (req, res) => {
  res.json({ app: 'md-editor', api: 1, version: APP_VERSION });
});

app.get('/api/undo-status', (req, res) => {
  const current = readJSON(CONTENT_FILE);
  res.json({
    undoLen: undoStack.length,
    redoLen: redoStack.length,
    redoLimit: current ? getHistoryLimit(current) : DEFAULT_REDO_LIMIT
  });
});

// List snapshots
app.get('/api/snapshots', (req, res) => {
  ensureDirs();
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
  res.json(files);
});

// Get specific snapshot
app.get('/api/snapshot/:date', (req, res) => {
  const filePath = path.join(SNAPSHOT_DIR, `${req.params.date}.json`);
  const data = readJSON(filePath);
  if (!data) return res.status(404).json({ error: 'Snapshot not found' });
  res.json(data);
});

// Compute diff between current content and today's snapshot (for "today's updates")
app.get('/api/today-diff', (req, res) => {
  ensureDirs();
  const snapshotFile = path.join(SNAPSHOT_DIR, `${today()}.json`);
  const snapshot = readJSON(snapshotFile);
  const content = readJSON(CONTENT_FILE);

  if (!snapshot || !content) {
    return res.json({ totalAdded: 0, totalModified: 0, totalRemoved: 0, groups: {} });
  }

  res.json(computeDiff(snapshot, content));
});

// Compute diff between two dates
app.get('/api/diff', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const fromFile = path.join(SNAPSHOT_DIR, `${from}.json`);
  const toFile = path.join(SNAPSHOT_DIR, `${to}.json`);

  const fromData = readJSON(fromFile);
  const toData = readJSON(toFile);

  if (!fromData) return res.status(404).json({ error: `Snapshot ${from} not found` });
  if (!toData) return res.status(404).json({ error: `Snapshot ${to} not found` });

  res.json(computeDiff(fromData, toData));
});

// Compute diff across a date range (from the earliest snapshot before 'from' to the 'to' snapshot)
app.get('/api/range-diff', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  ensureDirs();
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();

  // Find the baseline: latest snapshot BEFORE 'from'
  let baseline = null;
  for (const f of files) {
    if (f < from) baseline = f;
    else break;
  }
  if (!baseline) {
    // Use the 'from' date itself
    baseline = from;
  }

  // Use the 'to' date or current content if 'to' is today
  let toData;
  if (to === today()) {
    toData = readJSON(CONTENT_FILE);
  } else {
    toData = readJSON(path.join(SNAPSHOT_DIR, `${to}.json`));
  }

  const fromData = readJSON(path.join(SNAPSHOT_DIR, `${baseline}.json`));

  if (!fromData || !toData) {
    return res.json({ totalAdded: 0, totalModified: 0, totalRemoved: 0, groups: {} });
  }

  res.json(computeDiff(fromData, toData));
});

// Export content as Markdown
// Markdown を取り込んでブロックに変換する。
// ここでは変換するだけで、保存はしない（どこに差し込むかは画面側が決める）。
// 保存まで一気にやらないのは、取り込む前に「何件になるか」を見せて止められるようにするため。
app.post('/api/import-md', (req, res) => {
  const markdown = req.body && typeof req.body.markdown === 'string' ? req.body.markdown : null;
  if (markdown === null) return res.status(400).json({ error: 'markdown（文字列）が必要です' });
  try {
    const result = parseMarkdown(markdown);
    res.json(result);
  } catch (e) {
    console.error('[import-md] 変換に失敗:', e);
    res.status(500).json({ error: 'Markdown の変換に失敗しました: ' + e.message });
  }
});

app.get('/api/export-md', (req, res) => {
  ensureDirs();
  const content = readJSON(CONTENT_FILE);
  if (!content) return res.status(404).json({ error: 'No content' });

  function blocksToMd(blocks, depth) {
    const lines = [];
    for (const b of blocks) {
      if (b.type === 'heading') {
        const prefix = b.level === 2 ? '#####\u3000' : '##### ';
        const text = (b.text || '').replace(/<code>/g, '`').replace(/<\/code>/g, '`').replace(/<[^>]+>/g, '');
        lines.push(prefix + text);
        lines.push('');
      } else if (b.type === 'paragraph') {
        const indent = '&#x09;'.repeat(b.indent || 0);
        const text = (b.text || '').replace(/<code>/g, '`').replace(/<\/code>/g, '`').replace(/<br>/g, '\n' + indent).replace(/<[^>]+>/g, '');
        lines.push(indent + text);
        lines.push('');
      } else if (b.type === 'code') {
        lines.push('```' + (b.language || ''));
        lines.push(b.content || '');
        lines.push('```');
        lines.push('');
      } else if (b.type === 'table') {
        if (b.headers && b.headers.length) {
          lines.push('| ' + b.headers.join(' | ') + ' |');
          lines.push('| ' + b.headers.map(() => '---').join(' | ') + ' |');
          (b.rows || []).forEach(row => {
            lines.push('| ' + row.map(c => (c || '').replace(/<[^>]+>/g, '')).join(' | ') + ' |');
          });
          lines.push('');
        }
      } else if (b.type === 'section') {
        lines.push('[[ ' + (b.title || '') + ' ]]');
        lines.push(...blocksToMd(b.children || [], depth + 1));
        lines.push('[[/]]');
        lines.push('');
      }
    }
    return lines;
  }

  const md = blocksToMd(content.blocks, 0).join('\n');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="yarubekikoto.md"');
  res.send(md);
});

// ============================================================
//  Legacy snapshot support (.snapshot plain text files)
// ============================================================

const LEGACY_SNAPSHOT_DIR = path.join(process.env.USERPROFILE || '', 'tools', 'md-watcher', 'snapshots');



function readSnapshotLines(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
}

// --- Unified snapshot source ----------------------------------------------
// 履歴表示/MD出力は元々 md-watcher の .snapshot テキストだけを読んでいたが、
// md-watcher が無い環境（別PC移行後など）では履歴が空になってしまう。
// そこで md-watcher の .snapshot が無ければ、エディタ自身が保存している
// snapshots/<date>.json を blocksToSnapshot() で同形式に変換して使う。
// （blocksToSnapshot 形式は「本日更新」ライブ差分でも使われており diff 互換）

// 利用可能なスナップショット日付(YYYYMMDD)の昇順リスト。
// md-watcher の .snapshot と エディタ自身の snapshots/*.json を統合する。
function listSnapshotDates() {
  const set = new Set();
  if (fs.existsSync(LEGACY_SNAPSHOT_DIR)) {
    for (const f of fs.readdirSync(LEGACY_SNAPSHOT_DIR)) {
      if (f.endsWith('.snapshot')) set.add(f.replace('.snapshot', ''));
    }
  }
  if (fs.existsSync(SNAPSHOT_DIR)) {
    for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
      if (f.endsWith('.json')) set.add(f.replace('.json', ''));
    }
  }
  return [...set].sort();
}

// 指定日のスナップショット行を取得。md-watcher の .snapshot を優先し、
// 無ければエディタ自身の snapshots/<date>.json を blocksToSnapshot で変換。
function snapshotLinesFor(date) {
  const legacyFile = path.join(LEGACY_SNAPSHOT_DIR, `${date}.snapshot`);
  const legacyLines = readSnapshotLines(legacyFile);
  if (legacyLines) return legacyLines;
  const obj = readJSON(path.join(SNAPSHOT_DIR, `${date}.json`));
  if (obj && Array.isArray(obj.blocks)) return blocksToSnapshot(obj.blocks);
  return null;
}


function formatDateLabel(yyyyMMdd) {
  return `${yyyyMMdd.slice(0,4)}/${yyyyMMdd.slice(4,6)}/${yyyyMMdd.slice(6,8)}`;
}

// Get the current live content as snapshot lines (for diffing today's work)
function getCurrentContentLines() {
  const content = readJSON(CONTENT_FILE);
  if (!content) return null;
  return blocksToSnapshot(content.blocks);
}

function writeDailyBaseline(dateStr, lines) {
  if (!fs.existsSync(DAILY_LOG_DIR)) fs.mkdirSync(DAILY_LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAILY_LOG_DIR, `${dateStr}.baseline`), lines.join('\n'), 'utf-8');
  // Save blocks JSON so baseline can be re-serialized when snapshot format changes
  const content = readJSON(CONTENT_FILE);
  if (content && content.blocks) {
    writeJSON(path.join(DAILY_LOG_DIR, `${dateStr}.baseline-blocks.json`), content.blocks);
  }
  writeJSON(path.join(DAILY_LOG_DIR, `${dateStr}.json`), {
    date: dateStr,
    totalLines: 0,
    groups: []
  });
}

// ── 整理モード (reorg mode): ON中の変更を本日更新/履歴に出さないための状態管理 ──
const REORG_STATE_FILE = path.join(DATA_DIR, 'reorg-state.json');
function readReorgState() {
  const s = readJSON(REORG_STATE_FILE);
  return (s && typeof s === 'object') ? s : { active: false };
}
function writeReorgState(state) {
  writeJSON(REORG_STATE_FILE, state || { active: false });
}
function isReorgActiveFor(dateStr) {
  const s = readReorgState();
  return !!(s.active && s.date === dateStr);
}
function getReorgAnchorLines(dateStr) {
  const f = path.join(DAILY_LOG_DIR, `${dateStr}.reorg-anchor`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').split(/\r?\n/);
  return null;
}
// 本日更新/履歴の diff で使う「新」側の行。整理モード中は anchor で凍結する。
function reorgAwareNewLines(dateStr, currentLines) {
  if (isReorgActiveFor(dateStr)) {
    const anchor = getReorgAnchorLines(dateStr);
    if (anchor) return anchor;
  }
  return currentLines;
}

function getBaselineLines(todayDate) {
  // 整理モードで調整済みのベースラインがあれば最優先（reorgで取り込んだ分を含む）
  const reorgBaselineFile = path.join(DAILY_LOG_DIR, `${todayDate}.baseline-reorg`);
  if (fs.existsSync(reorgBaselineFile)) {
    return fs.readFileSync(reorgBaselineFile, 'utf-8').split(/\r?\n/);
  }
  // Prefer blocks JSON (re-serialize with current blocksToSnapshot for format consistency)
  const blocksFile = path.join(DAILY_LOG_DIR, `${todayDate}.baseline-blocks.json`);
  const blocks = readJSON(blocksFile);
  if (Array.isArray(blocks)) {
    return blocksToSnapshot(blocks);
  }
  // Fallback: legacy text baseline
  const baselineFile = path.join(DAILY_LOG_DIR, `${todayDate}.baseline`);
  if (fs.existsSync(baselineFile)) {
    return fs.readFileSync(baselineFile, 'utf-8').split(/\r?\n/);
  }
  return null;
}

// Save today's "本日更新セクション" as a daily log (primary source for history)
// Uses a baseline snapshot (same serialization as live content) to avoid
// encoding mismatches between md-watcher snapshots and content.json
function saveDailyLog() {
  try {
    const todayDate = today();
    const baselineFile = path.join(DAILY_LOG_DIR, `${todayDate}.baseline`);
    const newLines = getCurrentContentLines();
    if (!newLines) return;

    // First save of the day: create baseline from current content
    if (!fs.existsSync(baselineFile)) {
      writeDailyBaseline(todayDate, newLines);
      return;
    }

    // Subsequent saves: diff baseline vs current（整理モード中は anchor で凍結）
    const oldLines = getBaselineLines(todayDate) || [];
    const diffNewLines = reorgAwareNewLines(todayDate, newLines);

    const { updates, updateOrder } = computeLegacyDiff(oldLines, diffNewLines);
    const groups = [];
    let totalLines = 0;
    for (const key of updateOrder) {
      const items = updates.get(key);
      totalLines += items.length;
      const isNew = key.includes(' >NEW> ');
      const label = key.replace(' >NEW> ', ' > [NEW] ');
      groups.push({ key: label, isNew, items, count: items.length });
    }

    writeJSON(path.join(DAILY_LOG_DIR, `${todayDate}.json`), {
      date: todayDate,
      totalLines,
      groups
    });
  } catch (_) { /* non-critical: don't break save */ }
}

// Read a daily log file (returns null if not found)
function readDailyLog(dateStr) {
  const logFile = path.join(DAILY_LOG_DIR, `${dateStr}.json`);
  return readJSON(logFile);
}

app.post('/api/reset-today-baseline', (req, res) => {
  ensureDirs();
  const currentLines = getCurrentContentLines();
  if (!currentLines) {
    return res.status(404).json({ ok: false, error: 'No content to baseline' });
  }

  const todayDate = today();

  // ★「本日更新」が見ているのは snapshots/<日付>.json のほう。
  //   ここを書き換えないと、画面の「今日の差分表示はリセットされます」が嘘になる。
  //   以前は daily-logs 側（履歴用）だけを書き換えていたので、
  //   ボタンを押しても本日更新がまったく変わらなかった。
  const content = readJSON(CONTENT_FILE);
  if (content) writeJSON(path.join(SNAPSHOT_DIR, `${todayDate}.json`), content);

  // 履歴側の起点も今に揃える
  writeDailyBaseline(todayDate, currentLines);

  // 整理モードで作った起点が残っていると、そちらが優先され続けて
  // やり直しが効かない。「今を起点にする」と言われた以上、これも捨てる。
  try { fs.unlinkSync(path.join(DAILY_LOG_DIR, `${todayDate}.baseline-reorg`)); } catch (_) {}

  res.json({ ok: true, date: todayDate });
});

// ── 整理モード ON/OFF ──
// ON中の変更は本日更新/履歴に出さない（整理専用）。ONにした時点の本日更新は保持。
app.post('/api/reorg-mode', (req, res) => {
  ensureDirs();
  const wantActive = !!(req.body && req.body.active);
  const dateStr = today();

  if (wantActive) {
    const currentLines = getCurrentContentLines();
    if (!currentLines) return res.status(404).json({ ok: false, error: 'No content' });
    // baseline が無ければ作る（初回アクセス相当）
    const baselineFile = path.join(DAILY_LOG_DIR, `${dateStr}.baseline`);
    if (!fs.existsSync(baselineFile)) writeDailyBaseline(dateStr, currentLines);
    // anchor = 現在（この時点の本日更新を凍結）
    fs.writeFileSync(path.join(DAILY_LOG_DIR, `${dateStr}.reorg-anchor`), currentLines.join('\n'), 'utf-8');
    writeReorgState({ active: true, date: dateStr });
    return res.json({ ok: true, active: true, date: dateStr });
  }

  // 終了: 整理中に増えた分だけをベースラインへ取り込む
  //   B' = baseline ∪ (current \ anchor)  （集合として使われるので順序は不問）
  const state = readReorgState();
  const d = (state && state.date) ? state.date : dateStr;
  const anchor = getReorgAnchorLines(d) || [];
  const baseline = getBaselineLines(d) || [];
  const currentLines = getCurrentContentLines() || [];
  const anchorCleaned = new Set(anchor.map(cleanLineForDiff));
  const reorgNew = currentLines.filter(line => !anchorCleaned.has(cleanLineForDiff(line)));
  const adjusted = baseline.concat(reorgNew);
  fs.writeFileSync(path.join(DAILY_LOG_DIR, `${d}.baseline-reorg`), adjusted.join('\n'), 'utf-8');
  writeReorgState({ active: false });
  try { fs.unlinkSync(path.join(DAILY_LOG_DIR, `${d}.reorg-anchor`)); } catch (_) {}
  // daily-log を再計算（diff(B', current)）
  saveDailyLog();
  return res.json({ ok: true, active: false, date: d });
});

app.get('/api/reorg-mode', (req, res) => {
  const s = readReorgState();
  res.json({ active: !!(s.active && s.date === today()), date: s.date || null });
});


// List legacy snapshots (md-watcher の .snapshot + エディタ自身の snapshots/*.json)
app.get('/api/legacy-snapshots', (req, res) => {
  res.json(listSnapshotDates());
});

// Today's diff using legacy snapshots (compare yesterday's snapshot vs today's)
app.get('/api/legacy-today', (req, res) => {
  const todayDate = today();
  const baselineFile = path.join(DAILY_LOG_DIR, `${todayDate}.baseline`);
  const newLines = getCurrentContentLines();

  if (!newLines) {
    return res.json({ totalLines: 0, totalGroups: 0, groups: [] });
  }

  // If no baseline yet, create it (first access of the day)
  if (!fs.existsSync(DAILY_LOG_DIR)) fs.mkdirSync(DAILY_LOG_DIR, { recursive: true });
  if (!fs.existsSync(baselineFile)) {
    writeDailyBaseline(todayDate, newLines);
    return res.json({ totalLines: 0, totalGroups: 0, groups: [], date: todayDate });
  }

  const oldLines = getBaselineLines(todayDate) || [];
  const diffNewLines = reorgAwareNewLines(todayDate, newLines);

  const { updates, updateOrder } = computeLegacyDiff(oldLines, diffNewLines);
  const groups = [];
  let totalLines = 0;
  for (const key of updateOrder) {
    const items = updates.get(key);
    totalLines += items.length;
    const isNew = key.includes(' >NEW> ');
    const label = key.replace(' >NEW> ', ' > [NEW] ');

    // Parse key to extract section and subheading
    let secPart, subPart;
    const newMatch = key.match(/^(.+) >NEW> (.+)$/);
    const normalMatch = key.match(/^(.+) > (.+)$/);
    if (newMatch) {
      secPart = newMatch[1];
      subPart = newMatch[2];
    } else if (normalMatch) {
      secPart = normalMatch[1];
      subPart = normalMatch[2];
    } else {
      secPart = key;
      subPart = null;
    }

    groups.push({ key: label, isNew, items, count: items.length, section: secPart, subheading: subPart });
  }

  res.json({ totalLines, totalGroups: groups.length, groups, date: todayDate });
});

// Compute legacy diff (line-based, snapshot-history.ps1 style)
app.get('/api/legacy-diff', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const oldLines = snapshotLinesFor(from);
  const newLines = snapshotLinesFor(to);

  if (!oldLines) return res.status(404).json({ error: `Snapshot ${from} not found` });
  if (!newLines) return res.status(404).json({ error: `Snapshot ${to} not found` });

  const { updates, updateOrder } = computeLegacyDiff(oldLines, newLines);

  // Convert to structured response
  const groups = [];
  let totalLines = 0;
  for (const key of updateOrder) {
    const items = updates.get(key);
    totalLines += items.length;
    const isNew = key.includes(' >NEW> ');
    const label = key.replace(' >NEW> ', ' > [NEW] ');
    groups.push({ key: label, isNew, items, count: items.length });
  }

  res.json({ totalLines, totalGroups: groups.length, groups });
});

// Legacy range diff (day-by-day breakdown like snapshot-history.ps1 -Mode range)
app.get('/api/legacy-range', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const files = listSnapshotDates();
  if (!files.length) return res.json({ days: [] });

  // Find baseline (closest <= from), to-snapshot (closest <= to),
  // and next-after-to (first > to) for inclusive endpoint coverage
  let baseDate = null;
  let toDate = null;
  let nextAfterTo = null;
  for (const f of files) {
    if (f <= from) baseDate = f;
    if (f <= to) toDate = f;
    if (nextAfterTo === null && f > to) nextAfterTo = f;
  }
  // Use nextAfterTo as diff endpoint so that work done on the To date is included
  const endDate = nextAfterTo || toDate;
  if (!baseDate || !endDate || baseDate === endDate) {
    return res.json({ days: [] });
  }

  // Day-by-day: use daily logs (primary) with snapshot diff (fallback)
  const days = [];
  const todayDate = today();
  for (let i = 0; i < files.length - 1; i++) {
    const d = files[i];
    if (d >= baseDate && d < endDate) {
      // Primary: saved daily log は存在すれば正本（daily-log 正本化）
      // 0行なら「変更なし」として何も出さない。スナップショット差分へはフォールバックしない。
      const log = readDailyLog(d);
      if (log && Array.isArray(log.groups)) {
        if (log.totalLines > 0) {
          days.push({ date: d, totalLines: log.totalLines, groups: log.groups });
        }
      } else {
        // Fallback: compute from snapshot diff（daily-log が無い過去日のみ）
        const oldL = snapshotLinesFor(d);
        let newL;
        if (files[i + 1] === todayDate && i + 1 === files.length - 1) {
          newL = getCurrentContentLines() || snapshotLinesFor(files[i + 1]);
        } else {
          newL = snapshotLinesFor(files[i + 1]);
        }
        const diff = computeLegacyDiff(oldL, newL);
        const dayGroups = [];
        let dayTotal = 0;
        for (const key of diff.updateOrder) {
          const items = diff.updates.get(key);
          dayTotal += items.length;
          dayGroups.push({ key: key.replace(' >NEW> ', ' > [NEW] '), isNew: key.includes(' >NEW> '), items, count: items.length });
        }
        if (dayTotal > 0) {
          days.push({ date: d, totalLines: dayTotal, groups: dayGroups });
        }
      }
    }
  }
  // Today: use daily log or live diff
  if (to >= todayDate) {
    const alreadyIncluded = days.some(d => d.date === todayDate);
    if (!alreadyIncluded) {
      const log = readDailyLog(todayDate);
      if (log && log.groups && log.totalLines > 0) {
        days.push({ date: todayDate, totalLines: log.totalLines, groups: log.groups });
      } else if (toDate === todayDate && files[files.length - 1] === todayDate) {
        // Live fallback
        const oldL = snapshotLinesFor(todayDate);
        const newL = getCurrentContentLines();
        if (oldL && newL) {
          const diff = computeLegacyDiff(oldL, newL);
          const dayGroups = [];
          let dayTotal = 0;
          for (const key of diff.updateOrder) {
            const items = diff.updates.get(key);
            dayTotal += items.length;
            dayGroups.push({ key: key.replace(' >NEW> ', ' > [NEW] '), isNew: key.includes(' >NEW> '), items, count: items.length });
          }
          if (dayTotal > 0) {
            days.push({ date: todayDate, totalLines: dayTotal, groups: dayGroups });
          }
        }
      }
    }
  }

  res.json({
    days
  });
});

// Helper: push formatted diff items to output array as proper Markdown
// dateLabel: e.g. "2026/05/22" — prepended to each section heading
// 履歴MD出力: [画像#id] を実画像(データURL)のMarkdown画像記法に変換する。
// 解決の優先順位（現在の content.json に依存しないのが肝）:
//   1) IMAGE_DIR に <id>.<ext> の実体があればそれを埋め込む。
//      → 後で削除・整理された画像でも、書き込みスルー/外部化で実体が残っていれば復元できる。
//   2) まだ外部化されていない当日画像などは、現 content 内のインラインbase64から。
//   3) どちらも取れない（id無しの旧データ / 実体が未取得で読めない）→「🖼 画像」ラベル。
// いずれも data URI（自己完結）に解決できた時だけ画像化し、リンク切れの記法は出さない。
// 返り値は先頭 "- " を付けない中身。
function renderImageItemForMd(item, content) {
  const m = typeof item === 'string' && item.match(/^\[画像(?:#(.+))?\]$/);
  if (!m) return null; // 画像行でない
  const id = m[1];
  // 1) IMAGE_DIR の実体を id から直接復元（現在のcontentに残っていなくてもよい）。
  const fromDisk = readImageFileById(id);
  if (fromDisk) return `![画像](${fromDisk})`;
  // 2) 実体がまだ無い（当日インライン画像など）→ 現 content のインラインbase64から。
  const block = id && content ? findImageBlockById(content.blocks, id) : null;
  if (block && block.src) {
    const resolved = resolveImageSrcForExport(block.src);
    if (typeof resolved === 'string' && resolved.startsWith('data:')) {
      return `![画像](${resolved})`;
    }
  }
  // 3) 復元不可 → リンク切れを避けてラベル。
  return '🖼 画像';
}

function pushFormattedDiff(output, diff, dateLabel, content) {
  for (const key of diff.updateOrder) {
    const items = diff.updates.get(key);
    const label = key.replace(' >NEW> ', ' > [NEW] ');
    const contentItems = items.filter(i => i !== '|BLANK|' && i !== '|PARAGRAPH_BREAK|' && i !== '|TABLE_START|' && i !== '|TABLE_END|');
    const contentCount = contentItems.length;

    // Skip entries with no actual content (heading-only, 0 lines)
    if (contentCount === 0) continue;

    output.push('');
    if (dateLabel) {
      output.push(`### ${dateLabel}　${label} (${contentCount} lines)`);
    } else {
      output.push(`### ${label} (${contentCount} lines)`);
    }
    output.push('');

    let inCode = false;
    for (const item of items) {
      if (item === '|BLANK|' || item === '|PARAGRAPH_BREAK|') {
        if (!inCode) output.push('');
        continue;
      }
      if (item === '|TABLE_START|' || item === '|TABLE_END|') continue;
      if (/^```/.test(item)) {
        inCode = !inCode;
        output.push(item);
        continue;
      }
      if (inCode) {
        output.push(item);
      } else {
        const img = renderImageItemForMd(item, content);
        output.push(`- ${img !== null ? img : item}`);
      }
    }
    // Ensure code fence is closed
    if (inCode) output.push('```');
    output.push('');
  }
}

// Helper: push formatted groups (from daily log) to output as proper Markdown
function pushFormattedGroups(output, groups, dateLabel, content) {
  for (const group of groups) {
    const items = group.items || [];
    const contentItems = items.filter(i => i !== '|BLANK|' && i !== '|PARAGRAPH_BREAK|' && i !== '|TABLE_START|' && i !== '|TABLE_END|');
    const contentCount = contentItems.length;
    if (contentCount === 0) continue;

    output.push('');
    if (dateLabel) {
      output.push(`### ${dateLabel}　${group.key} (${contentCount} lines)`);
    } else {
      output.push(`### ${group.key} (${contentCount} lines)`);
    }
    output.push('');

    let inCode = false;
    for (const item of items) {
      if (item === '|BLANK|' || item === '|PARAGRAPH_BREAK|') {
        if (!inCode) output.push('');
        continue;
      }
      if (item === '|TABLE_START|' || item === '|TABLE_END|') continue;
      if (/^```/.test(item)) {
        inCode = !inCode;
        output.push(item);
        continue;
      }
      if (inCode) {
        output.push(item);
      } else {
        const img = renderImageItemForMd(item, content);
        output.push(`- ${img !== null ? img : item}`);
      }
    }
    if (inCode) output.push('```');
    output.push('');
  }
}

// Export history diff as Markdown (styled, with dates — like snapshot-history.ps1)
// 履歴の Markdown を組み立てる。
// 以前はこの中身が /api/export-history-md のハンドラに直接書かれていた。
// HTML 版でも同じものが必要になったので、関数として切り出した（中の処理は変えていない）。
// 返り値: { ok: true, md } または { ok: false, status, error }
function buildHistoryMarkdown(query) {
  const { from, to, mode } = query || {};
  if (!from || !to) return { ok: false, status: 400, error: 'from and to required' };

  const files = listSnapshotDates();
  if (!files.length) {
    return { ok: false, status: 404, error: 'No snapshots found' };
  }

  // 画像行 [画像#id] を実画像に解決するための現行コンテンツ（読めなくても継続）。
  const content = readJSON(CONTENT_FILE) || { blocks: [] };

  const output = [];

  if (mode === 'all') {
    // All pairs
    output.push('# スナップショット履歴 (全期間)');
    output.push('');
    for (let i = 0; i < files.length - 1; i++) {
      const oldL = snapshotLinesFor(files[i]);
      const newL = snapshotLinesFor(files[i + 1]);
      const diff = computeLegacyDiff(oldL, newL);
      let total = 0;
      for (const items of diff.updates.values()) total += items.length;

      const dateDisp = formatDateLabel(files[i]);
      output.push(`## ${dateDisp} (${total} lines)`);
      output.push('');
      if (diff.updateOrder.length === 0) {
        output.push('(変更なし)');
      } else {
        pushFormattedDiff(output, diff, dateDisp, content);
      }
      output.push('');
    }
  } else {
    // Range mode
    let baseDate = null;
    let endDate = null;
    for (const f of files) {
      if (f <= from) baseDate = f;
      if (f <= to) endDate = f;
    }

    if (baseDate && endDate && baseDate !== endDate) {
      const todayDate = today();
      // Day-by-day: daily logs (primary) with snapshot diff (fallback)
      for (let i = 0; i < files.length; i++) {
        const d = files[i];
        // 選択範囲の終端日(endDate)も含める。今日は後段の専用ブロックで扱うため除外。
        if (d >= baseDate && d <= endDate && d !== todayDate) {
          const dateDisp = formatDateLabel(d);
          const log = readDailyLog(d);
          if (log && Array.isArray(log.groups)) {
            // daily-log が存在すれば正本。0行なら「変更なし」として何も出さない。
            if (log.totalLines > 0) {
              output.push(`## ${dateDisp} (${log.totalLines} lines)`);
              output.push('');
              pushFormattedGroups(output, log.groups, dateDisp, content);
              output.push('');
            }
          } else if (i + 1 < files.length) {
            // Fallback: snapshot diff（daily-log が無い過去日のみ）
            const oldL = snapshotLinesFor(d);
            let newL;
            if (files[i + 1] === todayDate && i + 1 === files.length - 1) {
              newL = getCurrentContentLines() || snapshotLinesFor(files[i + 1]);
            } else {
              newL = snapshotLinesFor(files[i + 1]);
            }
            const diff = computeLegacyDiff(oldL, newL);
            let dayTotal = 0;
            for (const items of diff.updates.values()) dayTotal += items.length;
            if (dayTotal > 0) {
              output.push(`## ${dateDisp} (${dayTotal} lines)`);
              output.push('');
              pushFormattedDiff(output, diff, dateDisp, content);
              output.push('');
            }
          }
        }
      }
      // Today: daily log or live fallback
      if (to >= todayDate) {
        const alreadyIncluded = output.some(l => l.includes(formatDateLabel(todayDate)));
        if (!alreadyIncluded) {
          const dateDisp = formatDateLabel(todayDate);
          const log = readDailyLog(todayDate);
          if (log && log.groups && log.totalLines > 0) {
            output.push(`## ${dateDisp} (${log.totalLines} lines)`);
            output.push('');
            pushFormattedGroups(output, log.groups, dateDisp, content);
            output.push('');
          } else if (endDate === todayDate && files[files.length - 1] === todayDate) {
            const oldL = snapshotLinesFor(todayDate);
            const newL = getCurrentContentLines();
            if (oldL && newL) {
              const diff = computeLegacyDiff(oldL, newL);
              let dayTotal = 0;
              for (const items of diff.updates.values()) dayTotal += items.length;
              if (dayTotal > 0) {
                output.push(`## ${dateDisp} (${dayTotal} lines)`);
                output.push('');
                pushFormattedDiff(output, diff, dateDisp, content);
                output.push('');
              }
            }
          }
        }
      }
    }
  }

  return { ok: true, md: output.join('\n') };
}

function historyFileLabel(from, to) {
  return String(from).replace(/(\d{4})(\d{2})(\d{2})/, '$1$2$3') + '-' +
         String(to).replace(/(\d{4})(\d{2})(\d{2})/, '$1$2$3');
}

app.get('/api/export-history-md', (req, res) => {
  const r = buildHistoryMarkdown(req.query);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="history_${historyFileLabel(req.query.from, req.query.to)}.md"`);
  res.send(r.md);
});

// 履歴を「1ファイルで完結する HTML」として書き出す。
// 中身は Markdown 版とまったく同じものを使い、見せ方だけ変える。
// 画像は data URI に埋め込むので、渡した相手のPCでもそのまま開ける。
app.get('/api/export-history-html', (req, res) => {
  const r = buildHistoryMarkdown(req.query);
  if (!r.ok) return res.status(r.status).json({ error: r.error });

  const content = readJSON(CONTENT_FILE) || {};
  const docTitle = (content.appConfig && content.appConfig.documentTitle) || content.title || 'ドキュメント';
  const fmt = (d) => String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1/$2/$3');
  const html = buildHistoryHtml(r.md, {
    title: docTitle + ' — 変更の履歴',
    rangeLabel: req.query.mode === 'all'
      ? '全期間'
      : fmt(req.query.from) + ' 〜 ' + fmt(req.query.to),
    // ★画像の取り出し方はこちらから渡す。lib 側はファイルを触らない
    //   （同じコードをブラウザのオンライン版でも読むため）。
    readImage: (fileName) => {
      const file = path.join(IMAGE_DIR, fileName);
      if (!fs.existsSync(file)) return null;
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp' : 'image/png';
      return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
    },
    generatedLabel: '書き出し: ' + new Date().toLocaleString('ja-JP')
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="history_${historyFileLabel(req.query.from, req.query.to)}.html"`);
  res.send(html);
});

// Export as self-contained HTML (for distribution)
app.get('/api/export-html', async (req, res) => {
  ensureDirs();
  const content = readJSON(CONTENT_FILE);
  if (!content) return res.status(404).json({ error: 'No content' });

  // Read local CSS
  const cssPath = path.join(__dirname, 'public', 'style.css');
  const css = fs.readFileSync(cssPath, 'utf-8');

  // highlight.js の配色とスクリプトは同梱ファイルから読む。
  // 以前は書き出しのたびに cdnjs へ取りに行っていたが、(a) 書き出す側がオフラインだと
  // 無警告で配色の抜けた HTML ができ、(b) 受け取った側もネットが無いと色が付かなかった。
  // 配布用HTMLは「1ファイルで完結して誰にでも渡せる」ことが売りなので、全部埋め込む。
  const VENDOR_DIR = path.join(__dirname, 'public', 'vendor', 'highlight');
  const readVendor = (name) => {
    try { return fs.readFileSync(path.join(VENDOR_DIR, name), 'utf-8'); }
    catch (e) { console.warn(`[export-html] 同梱ファイルが読めません: ${name} (${e.message})`); return ''; }
  };
  const hljsCss = readVendor('github-dark-dimmed.min.css');
  const hljsJs = [
    'highlight.min.js', 'sql.min.js', 'vbnet.min.js', 'powershell.min.js',
  ].map(readVendor).join('\n;\n');

  // Build static HTML from blocks
  // Collect today's updated section names for preview
  const updatedSectionNames = new Set();

  function blocksToHtml(blocks) {
    let html = '';
    for (const b of blocks) {
      if (b.type === 'heading') {
        const level = b.level || 1;
        const tag = level === 1 ? 'h2' : 'h3';
        html += `<div class="block block-heading level-${level}" id="block-${b.id}"><${tag}>${b.text || ''}</${tag}></div>\n`;
      } else if (b.type === 'paragraph') {
        const indentClass = b.indent ? ` indent-${b.indent}` : '';
        html += `<div class="block block-paragraph${indentClass}">${b.text || ''}</div>\n`;
      } else if (b.type === 'code') {
        const lang = b.language || '';
        const langMap = { 'vb': 'vbnet', 'csharp': 'csharp' };
        const langClass = lang ? `language-${langMap[lang] || lang}` : '';
        const header = lang ? `<div class="code-header">${lang}</div>` : '';
        html += `<div class="block block-code">${header}<pre><code class="${langClass}">${escapeHtmlServer(b.content || '')}</code></pre></div>\n`;
      } else if (b.type === 'table') {
        let tbl = '<table><thead><tr>';
        (b.headers || []).forEach(h => { tbl += `<th>${escapeHtmlServer(h)}</th>`; });
        tbl += '</tr></thead><tbody>';
        (b.rows || []).forEach(row => {
          tbl += '<tr>';
          row.forEach(cell => { tbl += `<td>${cell}</td>`; });
          tbl += '</tr>';
        });
        tbl += '</tbody></table>';
        html += `<div class="block block-table">${tbl}</div>\n`;
      } else if (b.type === 'image') {
        const alt = escapeHtmlServer(b.alt || '');
        const imgSrc = resolveImageSrcForExport(b.src);
        html += `<div class="block block-image"><img src="${imgSrc}" alt="${alt}" class="block-image-content" style="max-width:100%;height:auto;border-radius:6px;"></div>\n`;
      } else if (b.type === 'section') {
        const sectionTitle = b.title || '';
        const hasPreview = updatedSectionNames.has(sectionTitle);
        let sec = `<div class="block block-section collapsed${hasPreview ? ' has-today-preview' : ''}" id="block-${b.id}">`;
        sec += `<div class="section-header"><span class="toggle-icon">▼</span><span class="section-title">${escapeHtmlServer(sectionTitle)}</span>`;
        sec += `<span class="section-badge">(${(b.children || []).length} 件)</span></div>`;
        // Preview div (populated later by JS or pre-built here)
        sec += `<div class="section-preview" data-section-name="${escapeHtmlServer(sectionTitle)}"></div>`;
        sec += `<div class="section-body">${blocksToHtml(b.children || [])}</div></div>\n`;
        html += sec;
      }
    }
    return html;
  }

  // Build navigation
  function buildNavHtml(blocks) {
    let html = '';
    for (const b of blocks) {
      if (b.type === 'section') {
        html += `<li class="nav-item"><a href="#block-${b.id}">${escapeHtmlServer(b.title || '(無題)')}</a></li>\n`;
        if (b.children) {
          for (const child of b.children) {
            if (child.type === 'heading') {
              const text = (child.text || '').replace(/<[^>]+>/g, '');
              html += `<li class="nav-item sub"><a href="#block-${child.id}">${escapeHtmlServer(text || '(無題)')}</a></li>\n`;
            }
          }
        }
      } else if (b.type === 'heading') {
        const text = (b.text || '').replace(/<[^>]+>/g, '');
        html += `<li class="nav-item"><a href="#block-${b.id}">${escapeHtmlServer(text || '(無題)')}</a></li>\n`;
      }
    }
    return html;
  }

  const title = content.title || 'ドキュメント';

  // Build today's updates section (must run before blocksToHtml to populate updatedSectionNames)
  let todayNavHtml = '';
  let todayMainHtml = '';
  let todayData = null;

  try {
    {
      const files = listSnapshotDates();
      const todayDate = today();
      let todayIdx = files.indexOf(todayDate);
      if (todayIdx < 0) todayIdx = files.length - 1;
      if (todayIdx > 0) {
        const prevDate = files[todayIdx - 1];
        const currDate = files[todayIdx];
        const oldLines = snapshotLinesFor(prevDate);
        const newLines = snapshotLinesFor(currDate);
        if (oldLines && newLines) {
          const { updates, updateOrder } = computeLegacyDiff(oldLines, newLines);
          const groups = [];
          let totalLines = 0;
          for (const key of updateOrder) {
            const items = updates.get(key);
            totalLines += items.length;
            const isNew = key.includes(' >NEW> ');
            let secPart, subPart;
            const newMatch = key.match(/^(.+) >NEW> (.+)$/);
            const normalMatch = key.match(/^(.+) > (.+)$/);
            if (newMatch) { secPart = newMatch[1]; subPart = newMatch[2]; }
            else if (normalMatch) { secPart = normalMatch[1]; subPart = normalMatch[2]; }
            else { secPart = key; subPart = null; }
            groups.push({ isNew, items, section: secPart, subheading: subPart });
          }
          if (groups.length > 0) {
            todayData = { totalGroups: groups.length, groups };
            const d = new Date();
            const todayLabel = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;

            // Nav today section
            todayNavHtml += `<div class="today-section" style="display:block">`;
            todayNavHtml += `<div class="today-header"><span class="today-toggle">▼</span>`;
            todayNavHtml += `<strong>📋 本日更新 (${todayLabel})</strong>`;
            todayNavHtml += `<small class="today-badge">${groups.length} 件</small></div>`;
            todayNavHtml += `<div class="today-body">`;
            let prevSection = null;
            let navSubIdx = 0;
            for (const group of groups) {
              if (group.section !== prevSection) {
                if (prevSection !== null) todayNavHtml += `<div class="today-spacer"></div>`;
                todayNavHtml += `<div class="today-section-label">${escapeHtmlServer(group.section)}</div>`;
                prevSection = group.section;
              }
              if (group.subheading) {
                const todayMainId = `today-main-${navSubIdx}`;
                navSubIdx++;
                todayNavHtml += `<div class="today-subheading">`;
                todayNavHtml += `<span class="today-quote">&gt;&gt;</span> `;
                if (group.isNew) todayNavHtml += `<span class="new-badge">NEW</span> `;
                todayNavHtml += `<a class="today-jump" href="#${todayMainId}"><b>${escapeHtmlServer(group.subheading)}</b></a>`;
                todayNavHtml += `</div>`;
              }
            }
            todayNavHtml += `</div></div>`;

            // Main today section
            todayMainHtml += `<div class="today-section" id="todaySectionMain" style="display:block">`;
            todayMainHtml += `<div class="today-header"><span class="today-toggle">▼</span>`;
            todayMainHtml += `<strong>📋 本日更新 (${todayLabel})</strong>`;
            todayMainHtml += `<small class="today-badge">${groups.length} 件</small></div>`;
            todayMainHtml += `<div class="today-body">`;
            prevSection = null;
            let mainSubIdx = 0;
            for (const group of groups) {
              if (group.section !== prevSection) {
                if (prevSection !== null) todayMainHtml += `<div class="today-spacer"></div>`;
                todayMainHtml += `<div class="today-section-label">${escapeHtmlServer(group.section)}</div>`;
                prevSection = group.section;
              }
              if (group.subheading) {
                const todayMainId = `today-main-${mainSubIdx}`;
                mainSubIdx++;
                todayMainHtml += `<div class="today-subheading" id="${todayMainId}">`;
                todayMainHtml += `<span class="today-quote">&gt;&gt;</span> `;
                if (group.isNew) todayMainHtml += `<span class="new-badge">NEW</span> `;
                todayMainHtml += `<b>${escapeHtmlServer(group.subheading)}</b>`;
                todayMainHtml += `</div>`;
              }
              let inCodeFence = false;
              for (const item of group.items) {
                if (/^```/.test(item)) {
                  inCodeFence = !inCodeFence;
                  if (inCodeFence) {
                    const codeLang = item.replace(/^```/, '').trim();
                    const langMap = { 'vb': 'vbnet', 'csharp': 'csharp' };
                    const langClass = codeLang ? `language-${langMap[codeLang] || codeLang}` : '';
                    todayMainHtml += `<pre class="today-code"><code class="${langClass}">`;
                  } else {
                    todayMainHtml += `</code></pre>`;
                  }
                  continue;
                }
                if (inCodeFence) {
                  todayMainHtml += escapeHtmlServer(item) + '\n';
                  continue;
                }
                if (item === '|BLANK|') {
                  todayMainHtml += `<div class="today-blank"></div>`;
                  continue;
                }
                if (item === '|PARAGRAPH_BREAK|') {
                  todayMainHtml += `<div class="today-paragraph-break"></div>`;
                  continue;
                }
                if (/^\s*\|/.test(item)) {
                  todayMainHtml += `<div class="today-table-line">${escapeHtmlServer(item)}</div>`;
                  continue;
                }
                if (item === '|TABLE_START|' || item === '|TABLE_END|') continue;
                const imgMatchExport = item.match(/^\[画像(?:#(.+))?\]$/);
                if (imgMatchExport) {
                  const imgBlock = imgMatchExport[1] ? findImageBlockById(content.blocks, imgMatchExport[1]) : null;
                  if (imgBlock && imgBlock.src) {
                    const resolved = resolveImageSrcForExport(imgBlock.src);
                    todayMainHtml += `<img class="today-image" src="${String(resolved).replace(/"/g, '&quot;')}" alt="画像">`;
                  } else {
                    const indentImg = group.subheading ? 'today-content-sub' : 'today-content';
                    todayMainHtml += `<div class="${indentImg}">🖼 画像</div>`;
                  }
                  continue;
                }
                const indent = group.subheading ? 'today-content-sub' : 'today-content';
                todayMainHtml += `<div class="${indent}">${escapeHtmlServer(item)}</div>`;
              }
            }
            todayMainHtml += `</div></div>`;
          }
        }
      }
    }
  } catch (_) { /* today section optional */ }

  // Populate updatedSectionNames from today data
  if (todayData && todayData.groups) {
    for (const group of todayData.groups) {
      if (group.section) updatedSectionNames.add(group.section);
    }
  }

  // Build HTML after today data is computed (so section previews work)
  const blocksHtml = blocksToHtml(content.blocks);
  const navHtml = buildNavHtml(content.blocks);

  // Build preview data as JSON for client-side preview population
  let previewDataJson = '{}';
  if (todayData && todayData.groups) {
    const previewMap = {};
    for (const group of todayData.groups) {
      if (!group.section) continue;
      if (!previewMap[group.section]) previewMap[group.section] = [];
      for (const item of group.items) {
        if (previewMap[group.section].length >= 4) break;
        if (/^```/.test(item) || item === '|BLANK|' || item === '|PARAGRAPH_BREAK|' || item === '|TABLE_START|' || item === '|TABLE_END|') continue;
        const trimmed = item.trim();
        if (trimmed) previewMap[group.section].push(trimmed);
      }
    }
    previewDataJson = JSON.stringify(previewMap);
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtmlServer(title)}</title>
<style>${hljsCss}</style>
<style>${css}
/* Export overrides */
body { padding: 0; }
.toolbar, .block-controls, .add-block-row, .table-controls { display: none !important; }
nav { position: fixed; top: 0; left: 0; width: var(--nav-w); height: 100vh; overflow-y: auto; }
main { margin-left: var(--nav-w); padding: 40px 60px; min-height: 100vh; }
.block-section .section-header { cursor: pointer; }
.block-code pre { max-height: none; }
.block-code.code-collapsed pre { max-height: none; }
</style>
</head>
<body class="view-mode">
<nav>
<h2>ナビゲーション</h2>
<ul class="nav-list">${navHtml}</ul>
${todayNavHtml}
</nav>
<main>
<div id="blocksContainer">${blocksHtml}</div>
${todayMainHtml}
</main>
<script>${hljsJs}<\/script>
<script>
// Highlight code blocks
hljs.highlightAll();

// Section preview data
var _previewData = ${previewDataJson};

// Populate section previews
document.querySelectorAll('.section-preview[data-section-name]').forEach(function(prev) {
  var name = prev.getAttribute('data-section-name');
  var lines = _previewData[name];
  if (!lines || !lines.length) return;
  lines.forEach(function(line) {
    var p = document.createElement('div');
    p.className = 'section-preview-line';
    p.textContent = line;
    prev.appendChild(p);
  });
  // Click preview → expand section and jump to first updated heading
  prev.addEventListener('click', function() {
    var section = prev.closest('.block-section');
    if (section) {
      section.classList.remove('collapsed');
      // Try to find matching heading in the section body
      var body = section.querySelector('.section-body');
      if (body) {
        var headings = body.querySelectorAll('.block');
        for (var i = 0; i < headings.length; i++) {
          var h = headings[i];
          var text = (h.textContent || '').trim();
          // Check if any preview line is part of this block's text
          if (lines.some(function(l) { return text.indexOf(l) >= 0; })) {
            setTimeout(function() {
              h.scrollIntoView({ behavior: 'smooth', block: 'center' });
              h.style.outline = '2px solid var(--accent)';
              setTimeout(function() { h.style.outline = ''; }, 1500);
            }, 50);
            return;
          }
        }
      }
      setTimeout(function() {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
  });
});

// Section toggle
document.querySelectorAll('.block-section .section-header').forEach(function(h) {
  h.addEventListener('click', function() { h.parentElement.classList.toggle('collapsed'); });
});

// Today section toggle
document.querySelectorAll('.today-header').forEach(function(h) {
  h.addEventListener('click', function() { h.parentElement.classList.toggle('today-collapsed'); });
});

// Nav click
document.querySelectorAll('.nav-list a').forEach(function(a) {
  a.addEventListener('click', function(e) {
    e.preventDefault();
    var target = document.querySelector(a.getAttribute('href'));
    if (target) {
      var sec = target.closest('.block-section.collapsed');
      if (sec) sec.classList.remove('collapsed');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.querySelectorAll('.nav-list a').forEach(function(l) { l.classList.remove('active'); });
    a.classList.add('active');
  });
});

// Today nav jump
document.querySelectorAll('.today-jump').forEach(function(a) {
  a.addEventListener('click', function(e) {
    e.preventDefault();
    var id = a.getAttribute('href').replace('#','');
    var el = document.getElementById(id);
    if (el) {
      var todayMain = document.getElementById('todaySectionMain');
      if (todayMain) todayMain.classList.remove('today-collapsed');
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Scroll spy
window.addEventListener('scroll', function() {
  var links = document.querySelectorAll('.nav-list a');
  var todayMain = document.getElementById('todaySectionMain');
  var todayJumps = document.querySelectorAll('.today-jump');
  var trigger = window.scrollY + window.innerHeight * 0.2;
  var viewH = window.innerHeight;
  var docH = document.documentElement.scrollHeight;

  links.forEach(function(l) { l.classList.remove('active'); });
  todayJumps.forEach(function(l) { l.classList.remove('today-active'); });

  if (todayMain) {
    var todayRect = todayMain.getBoundingClientRect();
    if (todayRect.top <= viewH * 0.3 || window.scrollY + viewH >= docH - 30) {
      var subs = todayMain.querySelectorAll('.today-subheading[id]');
      var activeId = null;
      subs.forEach(function(sh) {
        if (sh.getBoundingClientRect().top <= viewH * 0.3) activeId = sh.id;
      });
      if (activeId) {
        var navLink = document.querySelector('.today-jump[href="#' + activeId + '"]');
        if (navLink) navLink.classList.add('today-active');
      }
      return;
    }
  }

  var active = null;
  links.forEach(function(link) {
    var id = (link.getAttribute('href') || '').replace('#','');
    var el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top + window.scrollY <= trigger) active = link;
  });
  if (active) active.classList.add('active');
});
<\/script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title + '（閲覧用）')}.html"`);
  res.send(html);
});

// クライアントが数秒ごとに問い合わせ、別PCの更新を検知して自動反映するための状態。
app.get('/api/sync-status', (req, res) => {
  res.json({
    version: contentVersion(),      // content.json の版（変わったら別PCが更新した合図）
    others: listOtherPresence(),    // 在席中の別PC
    conflicts: scanForConflicts(),  // OneDriveの競合コピー等（あればUIで警告）
  });
});

// --- Start ---

// 旧ロック方式(EDITOR-LOCK*.json)の置き土産を掃除してから、自分の在席ファイルを書く。
// 起動をブロックはしない（両PC同時起動を許容し、更新はクライアント側で自動反映する）。
// 正常終了時に自分の在席ファイルを消す
function shutdown() {
  releasePresence();
  process.exit(0);
}

if (!EMBEDDED) {
  cleanupOldLockFiles();
  writePresence();
  presenceTimer = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);
  if (presenceTimer.unref) presenceTimer.unref();

  // 起動時に競合コピーがあればコンソールに知らせる（UIにも /api/sync-status で出る）
  const conflicts = scanForConflicts();
  if (conflicts.length) {
    console.warn('⚠ 競合の疑いがあるファイル:');
    for (const c of conflicts) console.warn(`   - ${c}`);
  }

  process.on('SIGINT', shutdown);   // Ctrl+C
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);   // コンソールの窓を閉じたとき
  process.on('exit', releasePresence);
}

// ── 起動（ポートが埋まっていても止まらないようにする）────────────
//
// 以前はポートが使われているだけで Node の例外がそのまま出て、
// 英語のスタックトレースだけが残った。何を直せばいいのか分からない。
// ここでは次の順で対応する:
//   1. 同じポートで「このアプリ自身」が既に動いていたら、それを開いて終わる
//      （二重に起動しない。ダブルクリックを2回してもちゃんと開く）
//   2. 別のものが使っていたら、空いている番号を順に探す
//   3. どれも駄目なら、日本語で理由と対処を出す
const MAX_PORT_TRIES = 10;

// ── 画面を開く ─────────────────────────────────────────────
//
// 「アプリモード」（--app=URL）で開けるブラウザがあれば、そちらを使う。
// 違いは見た目だけではない:
//   ・タブもアドレスバーも無い独立した窓になる
//   ・**タスクバーに独立した項目が出て、このアプリのアイコンが表示される**
//     （ふつうのタブで開くと、タスクバーに出るのはブラウザのアイコン）
// 見つからなければ、既定のブラウザにそのまま渡す（従来どおり動く）。
const APP_MODE_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findAppModeBrowser() {
  for (const p of APP_MODE_BROWSERS) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* 次を見る */ }
  }
  return null;
}

function openBrowser(url) {
  if (process.platform !== 'win32' || process.env.MD_EDITOR_NO_OPEN === '1') return;
  const { spawn, exec } = require('child_process');
  const browser = findAppModeBrowser();
  if (browser) {
    try {
      // 窓の大きさは初回だけの目安。以後はブラウザが覚える。
      // ★1320 は当てずっぽうではない。ツールバーの左のかたまりと右のかたまりの
      //   実寸を測って決めた値（左端〜952px、右側214px）。この幅だと間が
      //   約120px空き、意図して離してあるように見える。
      //   1280 だと右端の「設定」まで含めて画面からあふれていた（実測）。
      const child = spawn(browser, [`--app=${url}`, '--window-size=1320,880'],
        { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return;
    } catch (e) {
      console.warn('[warn] アプリモードで開けませんでした。既定のブラウザに渡します: ' + e.message);
    }
  }
  exec(`start "" "${url}"`);
}

// そのポートに居るのが「このアプリ」かどうかを確かめる。
// 別のアプリが偶然そのポートを使っていることがあるので、応答の中身まで見る。
function probeSelf(port) {
  return new Promise(resolve => {
    const req = require('http').get(
      { host: '127.0.0.1', port, path: '/api/whoami', timeout: 1200 },
      res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && j && j.app === 'md-editor');
          } catch (_) { resolve(false); }
        });
      });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function listenWithFallback(startPort) {
  // 1. 同じアプリが既に動いていないか
  if (await probeSelf(startPort)) {
    const url = `http://localhost:${startPort}`;
    console.log('');
    console.log('  やるべきこと-editor は、すでに起動しています。');
    console.log(`  その画面を開きます: ${url}`);
    console.log('');
    console.log('  （二重に起動する必要はありません。この画面は閉じて構いません）');
    openBrowser(url);
    setTimeout(() => process.exit(0), 800);
    return null;
  }

  // 2. 空いている番号を探す
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = startPort + i;
    const ok = await new Promise(resolve => {
      const srv = app.listen(port, () => resolve(srv));
      srv.on('error', err => {
        if (err && err.code === 'EADDRINUSE') resolve(null);
        else {
          console.error('');
          console.error('  起動できませんでした: ' + (err && err.message ? err.message : err));
          console.error('');
          process.exit(1);
        }
      });
    });
    if (ok) {
      if (i > 0) {
        console.log('');
        console.log(`  ポート ${startPort} は別のものが使っていたので、${port} で起動しました。`);
      }
      return port;
    }
  }

  // 3. どれも埋まっていた
  console.error('');
  console.error(`  ポート ${startPort} から ${startPort + MAX_PORT_TRIES - 1} まで、すべて使われていました。`);
  console.error('  ほかのアプリを終了してから、もう一度お試しください。');
  console.error('  番号を指定したい場合は、環境変数 PORT に空いている番号を入れてください。');
  console.error('');
  process.exit(1);
}

// ── 起動用のショートカットを用意する ───────────────────────────
//
// なぜ要るか: 起動ファイルは .cmd で、**.cmd には独自のアイコンを設定できない**。
// Windows の標準のバッチアイコンで出てしまう。
// 一方 .lnk（ショートカット）はアイコンを指定できるので、これを置く。
//
// なぜ配布時ではなく実行時に作るか: .lnk は対象を絶対パスで持つため、
// 作った場所と違うフォルダへ移されると壊れる。起動のたびに
// 「無ければ、いまのパスで作る」ようにすれば、どこへ移しても正しくなる。
//
// 作るのは配布物の形（app\ の1つ上に .cmd がある）のときだけ。
// 失敗しても起動は続ける（あれば嬉しいが、無くても困らないもの）。
function ensureShortcut() {
  if (process.platform !== 'win32') return;
  // ★インストーラ版では作らない。
  //   インストーラがスタートメニューとデスクトップに正しいアイコンで置くので、
  //   ここで作ると誰も見ないフォルダの中に同じものが二重にできる
  //   （アンインストールしても残り、「消えていない」と思われる）。
  //   zip 版では今までどおり作る。
  if (process.env.MD_EDITOR_NO_SHORTCUT) return;
  try {
    const parent = path.join(__dirname, '..');
    const launcher = path.join(parent, 'やるべきこと-editorを起動.cmd');
    if (!fs.existsSync(launcher)) return;          // 配布物の形ではない（ソースから起動）
    const lnk = path.join(parent, 'やるべきこと-editor.lnk');
    if (fs.existsSync(lnk)) return;                // 既にある
    const ico = path.join(__dirname, 'public', 'icons', 'app.ico');
    if (!fs.existsSync(ico)) return;

    // PowerShell の -Command なら実行ポリシーの対象外。引用符の二重化に注意。
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const ps = [
      '$w = New-Object -ComObject WScript.Shell;',
      '$s = $w.CreateShortcut(' + q(lnk) + ');',
      '$s.TargetPath = ' + q(launcher) + ';',
      '$s.WorkingDirectory = ' + q(parent) + ';',
      '$s.IconLocation = ' + q(ico) + ';',
      '$s.Description = ' + q('やるべきこと-editor を起動します') + ';',
      '$s.Save()',
    ].join(' ');
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true },
      (err) => {
        if (err) console.log('[info] ショートカットは作れませんでした（起動には影響しません）');
        else console.log('[info] ショートカット「やるべきこと-editor」を作りました');
      });
  } catch (_) { /* 起動を妨げない */ }
}

// ★ブラウザに埋め込んで使うときは、ここから先を動かさない。
//   待ち受けるポートも、置く場所も、開くブラウザも無い。
//   app（ルーティングの一式）だけを渡して終わる。
if (EMBEDDED) {
  module.exports = { app };
} else {

ensureShortcut();

listenWithFallback(PORT).then(actualPort => {
  if (actualPort === null) return;   // 既に動いていたので開いて終わった
  const PORT = actualPort;           // 以下の表示は実際に使えた番号で出す
  const url = `http://localhost:${PORT}`;
  // 人に向けた案内はここで出す。
  // 起動スクリプト(.cmd)側に日本語を書くと cmd.exe が読み違えるので、
  // 日本語は必ず node 側（UTF-8）で出す。.cmd は起動直前に chcp 65001 している。
  console.log('');
  console.log('  やるべきこと-editor を起動しました。');
  console.log('  ブラウザが自動で開きます。この画面は閉じないでください。');
  console.log('');
  console.log(`  画面      : ${url}`);
  console.log(`  保存先    : ${path.dirname(CONTENT_FILE)}`);
  console.log(`  使い方    : ${url}/guide/`);
  console.log('');
  console.log('  止めるときは、この画面で Ctrl+C。');
  console.log('');
  // ★機械が読む目印。自動テストはこの行で「起動した」と判断する。
  //   人向けの文面は読みやすさのために変わるので、その都度テストが壊れないよう
  //   この1行だけは形を変えないこと。
  console.log(`[ready] ${url}`);
  // 機械向けの詳細（問い合わせのときに読む）
  console.log(`[info] content=${CONTENT_FILE}`);
  console.log(`[info] snapshots=${SNAPSHOT_DIR}`);
  console.log(`[info] host=${HOSTNAME} port=${PORT}`);

  // ブラウザを開く。自動テスト・検証用に MD_EDITOR_NO_OPEN=1 で抑止できる。
  openBrowser(url);
});

} // if (EMBEDDED) ... else
