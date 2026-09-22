'use strict';

/*
 * 作業ファイル（プロジェクト）の名簿 ── ファイル版。
 *
 * 操作の規則そのものは lib/projects-core.js にある（オンライン版と共有）。
 * ここは「ファイルでどう読み書きするか」だけを受け持つ:
 *   名簿      … DATA_ROOT/projects.json（壊れた書き込みを避けるため一時ファイル経由）
 *   中身の情報 … <作業ファイルの場所>/data/content.json の更新時刻とブロック数
 *   削除      … 消さずに DATA_ROOT/_trash へ移す
 */

const fs = require('fs');
const path = require('path');
const core = require('./projects-core');

const { slugify, isValidId, DEFAULT_PROJECT_ID } = core;

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) { return null; }
}

// 壊れた書き込みで名簿を失わないよう、一時ファイルに書いてから置き換える。
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function createStore(options) {
  const { dataRoot, projectsFile, projectsDir, defaultName } = options;

  function rootOf(id) {
    return id === DEFAULT_PROJECT_ID ? dataRoot : path.join(projectsDir, id);
  }

  const store = core.createStore({
    readState: () => readJson(projectsFile),
    writeState: (state) => writeJsonAtomic(projectsFile, state),

    statProject: (id) => {
      const contentFile = path.join(rootOf(id), 'data', 'content.json');
      if (!fs.existsSync(contentFile)) return { exists: false };
      const c = readJson(contentFile);
      return {
        exists: true,
        updatedAt: fs.statSync(contentFile).mtime.toISOString(),
        blockCount: c && Array.isArray(c.blocks) ? c.blocks.length : null
      };
    },

    discardProject: (id) => {
      const src = rootOf(id);
      if (!fs.existsSync(src)) return null;
      const trashDir = path.join(dataRoot, '_trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      // 手元の時計で名前を付ける。UTC だと「昨日の日付のフォルダ」ができて、
      // あとから探すときに分かりにくい。
      const d = new Date();
      const p2 = n => String(n).padStart(2, '0');
      const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
                    '-' + p2(d.getHours()) + p2(d.getMinutes());
      const movedTo = path.join(trashDir, id + '-' + stamp);
      fs.renameSync(src, movedTo);
      return movedTo;
    }
  }, { defaultName });

  // rootOf はファイル版にしかない（server.js が場所を知るために使う）。
  return Object.assign({}, store, { rootOf });
}

module.exports = { createStore, slugify, isValidId, DEFAULT_PROJECT_ID };
