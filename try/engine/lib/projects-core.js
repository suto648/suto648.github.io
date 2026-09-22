/*
 * 作業ファイル（プロジェクト）の名簿の「規則」だけを持つ。
 *
 * 名簿の形:
 *   {
 *     "version": 1,
 *     "currentId": "default",
 *     "projects": [ { "id": "default", "name": "やるべきこと", "createdAt": "...", "lastOpenedAt": "..." }, ... ]
 *   }
 *
 * 既定の作業ファイル（id = "default"）は、このアプリを前から使っている人の
 * 既存データそのもの。名簿が無くても必ず1件目として存在するものとして扱う。
 * ＝ 名簿ファイルを消しても、今までのデータが見えなくなることはない。
 *
 * ★このファイルは外部I/Oを一切しない。
 *   保存先はサーバ版＝ファイル、オンライン版＝ブラウザの保存領域と
 *   まったく違うので、読み書きの手段は呼ぶ側から渡してもらう。
 *   一方で「同じ名前は作れない」「既定は消せない」といった規則は
 *   2つの版で食い違ってはいけないので、ここに1つだけ置く。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectsCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const DEFAULT_PROJECT_ID = 'default';

// 表示名から、フォルダ名に使える id を作る。
// 日本語のフォルダ名はそのままでも作れるが、OneDrive や zip を挟むと化けることがあるので
// 英数字とハイフンに寄せ、被ったら連番を足す。
function slugify(name, taken) {
  const has = taken instanceof Set ? (x) => taken.has(x)
    : Array.isArray(taken) ? (x) => taken.indexOf(x) >= 0
    : () => false;
  let base = String(name || '')
    .normalize('NFKC')
    .replace(/[^\w぀-ヿ一-鿿-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // 記号だけの名前など、何も残らなかったときだけ日付を使う。
  // （日本語の名前はそのままフォルダ名にする。Windows でも OneDrive でも扱えるうえ、
  //   フォルダを直接開いたときに中身が分かるほうが良い）
  if (!base) {
    const d = new Date();
    const p2 = n => String(n).padStart(2, '0');
    base = 'file-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
           '-' + p2(d.getHours()) + p2(d.getMinutes());
  }
  base = base.toLowerCase();
  if (base === DEFAULT_PROJECT_ID) base = base + '-1';
  let id = base;
  let n = 2;
  while (has(id)) { id = base + '-' + n; n++; }
  return id;
}

// id として受け取ってよい形か（パスを抜け出す文字を弾く）
function isValidId(id) {
  return typeof id === 'string' && /^[\w぀-ヿ一-鿿-]{1,64}$/.test(id) &&
    id !== '.' && id !== '..';
}

/**
 * 名簿の読み書きだけを外から渡してもらい、操作の規則はここで持つ。
 *
 * @param {object} io
 *   io.readState()        → 保存されている生の名簿（無ければ null）
 *   io.writeState(state)  → 名簿を保存する
 *   io.statProject(id)    → { exists, updatedAt, blockCount }（省略可）
 *   io.discardProject(id) → 中身を退避して、退避先を返す（省略可・null可）
 * @param {object} [options] { defaultName }
 */
function createStore(io, options) {
  const o = options || {};
  const defaultName = o.defaultName || 'やるべきこと';

  function load() {
    const raw = io.readState();
    const list = raw && Array.isArray(raw.projects) ? raw.projects : [];
    const cleaned = list.filter(p => p && isValidId(p.id));

    // 既定は必ず先頭に居る
    if (!cleaned.some(p => p.id === DEFAULT_PROJECT_ID)) {
      cleaned.unshift({
        id: DEFAULT_PROJECT_ID,
        name: defaultName,
        createdAt: null,
        lastOpenedAt: null
      });
    }
    let currentId = raw && raw.currentId;
    if (!cleaned.some(p => p.id === currentId)) currentId = DEFAULT_PROJECT_ID;
    return { version: 1, currentId, projects: cleaned };
  }

  function save(state) {
    io.writeState(state);
    return state;
  }

  // 一覧に、実際の中身から読める情報（最終更新・ブロック数）を足して返す。
  // 名簿に書いた値ではなく毎回中身を見るのは、別PCが更新した場合に名簿が古くなるため。
  function list() {
    const state = load();
    return {
      currentId: state.currentId,
      projects: state.projects.map(p => {
        let stat = null;
        try {
          stat = typeof io.statProject === 'function' ? io.statProject(p.id) : null;
        } catch (_) { /* 読めなければ null のまま。一覧は出す */ }
        stat = stat || {};
        return {
          id: p.id,
          name: p.name,
          isDefault: p.id === DEFAULT_PROJECT_ID,
          createdAt: p.createdAt || null,
          lastOpenedAt: p.lastOpenedAt || null,
          updatedAt: stat.updatedAt || null,
          blockCount: typeof stat.blockCount === 'number' ? stat.blockCount : null,
          // まだ一度も開いていない作業ファイルは中身が無い。
          // 「壊れている」ではないので、画面で区別できるように分けて返す。
          started: !!stat.exists
        };
      })
    };
  }

  function create(name) {
    const state = load();
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, status: 400, error: '名前を入力してください' };
    if (state.projects.some(p => p.name === trimmed)) {
      return { ok: false, status: 409, error: '同じ名前の作業ファイルが既にあります' };
    }
    const id = slugify(trimmed, new Set(state.projects.map(p => p.id)));
    const now = new Date().toISOString();
    state.projects.push({ id, name: trimmed, createdAt: now, lastOpenedAt: null });
    save(state);
    return { ok: true, id, name: trimmed };
  }

  function rename(id, name) {
    const state = load();
    const p = state.projects.find(x => x.id === id);
    if (!p) return { ok: false, status: 404, error: '見つかりません' };
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, status: 400, error: '名前を入力してください' };
    if (state.projects.some(x => x.id !== id && x.name === trimmed)) {
      return { ok: false, status: 409, error: '同じ名前の作業ファイルが既にあります' };
    }
    p.name = trimmed;
    save(state);
    return { ok: true, id, name: trimmed };
  }

  function open(id) {
    const state = load();
    const p = state.projects.find(x => x.id === id);
    if (!p) return { ok: false, status: 404, error: '見つかりません' };
    p.lastOpenedAt = new Date().toISOString();
    state.currentId = id;
    save(state);
    return { ok: true, id };
  }

  // 消すのではなく、退避する。
  // 作業ファイルの中身は本人の記録そのものなので、押し間違いで永久に消えるのは割に合わない。
  function remove(id) {
    if (id === DEFAULT_PROJECT_ID) {
      return { ok: false, status: 400, error: '既定の作業ファイルは削除できません' };
    }
    const state = load();
    const idx = state.projects.findIndex(x => x.id === id);
    if (idx < 0) return { ok: false, status: 404, error: '見つかりません' };

    let movedTo = null;
    if (typeof io.discardProject === 'function') movedTo = io.discardProject(id) || null;

    state.projects.splice(idx, 1);
    if (state.currentId === id) state.currentId = DEFAULT_PROJECT_ID;
    save(state);
    return { ok: true, id, movedTo, nextId: state.currentId };
  }

  return { load, save, list, create, rename, open, remove, isValidId, DEFAULT_PROJECT_ID };
}

return { createStore, slugify, isValidId, DEFAULT_PROJECT_ID };
}));
