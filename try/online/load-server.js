/*
 * server.js と lib/*.js を「そのまま」読み込んで、ブラウザの中で動く形にする。
 *
 * 写しを作らないので、オフライン版と計算がずれることが原理的に起きない。
 * 読み込む中身は配布物に同梱した同じファイルそのもの。
 *
 * 使い方:
 *   const sources = await LoadServer.fetchSources('./');   // 同梱ファイルを取ってくる
 *   const { app, fs } = LoadServer.create(sources, { env, onChange });
 *   const res = await app.handle('GET', '/api/content');
 */
(function (global) {
'use strict';

// 読み込む順番。下のものが上のものを require する。
const LIB_ORDER = [
  { key: 'projects-core', file: 'lib/projects-core.js' },
  { key: 'diff-core',     file: 'lib/diff-core.js' },
  { key: 'md-import',     file: 'lib/md-import.js' },
  { key: 'history-html',  file: 'lib/history-html.js' },
  { key: 'projects',      file: 'lib/projects.js' },
];
const SERVER_FILE = 'server.js';
// 版番号はここから読まれる（/api/whoami）。同梱しないと "0.0.0" を名乗ってしまい、
// 更新のお知らせが常に「新しい版があります」になる。
const PACKAGE_FILE = 'package.json';

// ★「配布用 HTML」を作るとき、server.js はこれらを**ファイルとして読む**。
//   1ファイルで完結させるために、中身を全部埋め込む作りだから。
//   オンライン版で置いていなかったため、配布用 HTML が 500 で落ちていた
//   （「人に渡す」は看板の機能なのに、オンライン版では使えなかった）。
//   画面が既に読み込んでいるものと同じなので、取り直しても実質ただ。
const PAGE_FILES = [
  'style.css',
  'vendor/highlight/github-dark-dimmed.min.css',
  'vendor/highlight/highlight.min.js',
  'vendor/highlight/sql.min.js',
  'vendor/highlight/vbnet.min.js',
  'vendor/highlight/powershell.min.js',
];

/**
 * @param {string} baseUrl  engine/（server.js と lib）の場所
 * @param {string} pageBase 画面のファイル（style.css など）の場所
 */
async function fetchSources(baseUrl, pageBase) {
  const base = String(baseUrl || './').replace(/\/?$/, '/');
  const pbase = String(pageBase == null ? './' : pageBase).replace(/\/?$/, '/');
  const out = {};
  const wanted = LIB_ORDER.map(l => l.file).concat([SERVER_FILE, PACKAGE_FILE]);
  await Promise.all(wanted.map(async (rel) => {
    const res = await fetch(base + rel, { cache: 'no-cache' });
    if (!res.ok) throw new Error('読み込めません: ' + rel + '（' + res.status + '）');
    out[rel] = await res.text();
  }));
  // 画面のファイルは、読めなくても本体は動かす（配布用 HTML だけが困る）。
  await Promise.all(PAGE_FILES.map(async (rel) => {
    try {
      const res = await fetch(pbase + rel, { cache: 'no-cache' });
      if (res.ok) out['public/' + rel] = await res.text();
    } catch (_) { /* 取れなければ置かない */ }
  }));
  return out;
}

// CommonJS の1ファイルを、与えた道具立てのもとで評価する。
//
// ★Date も渡している。ふだんは本物の Date をそのまま渡すので何も変わらない。
//   渡し替えられるようにしてあるのは、**日をまたぐ動きを試すため**。
//   この製品の値打ちは「何日ぶんかの履歴が1枚の週報になる」ことなのに、
//   実際の日付でしか動かせないと、1日ぶんしか確かめられない。
//   server.js 側には試験用の分岐を一切入れない（分岐は必ずずれていく）。
function evalModule(source, fileName, env) {
  const module = { exports: {} };
  const fn = new Function(
    'require', 'module', 'exports', '__dirname', '__filename',
    'process', 'Buffer', 'console', 'setInterval', 'clearInterval',
    'setTimeout', 'clearTimeout', 'URL', 'self', 'Date',
    source + '\n//# sourceURL=' + fileName
  );
  fn(env.require, module, module.exports, '/app', '/app/' + fileName,
     env.process, env.Buffer, console, env.setInterval, env.clearInterval,
     env.setTimeout, env.clearTimeout, URL, undefined, env.Date || Date);
  return module.exports;
}

/**
 * @param {object} sources  fetchSources の戻り（ファイル名 → 中身）
 * @param {object} options  { env, onChange }
 */
function create(sources, options) {
  const opts = options || {};
  const node = global.NodeShim.createNodeEnv({
    env: opts.env,
    onChange: opts.onChange
  });

  // タイマーはブラウザのものをそのまま使う。ただし unref は無いので足す
  // （server.js が presenceTimer.unref() を呼ぶが、埋め込み時はそこへ来ない）。
  const wrapInterval = (fn, ms) => {
    const id = global.setInterval(fn, ms);
    return { unref() {}, id, valueOf: () => id };
  };

  const env = {
    require: node.require,
    process: node.process,
    Buffer: node.Buffer,
    // ふだんは本物の Date。日をまたぐ試験のときだけ差し替える。
    Date: opts.clock || Date,
    setInterval: wrapInterval,
    clearInterval: global.clearInterval.bind(global),
    setTimeout: global.setTimeout.bind(global),
    clearTimeout: global.clearTimeout.bind(global)
  };

  // ★保存してあったものを、server.js を読む前に戻す。
  //   server.js は読み込んだ時点で名簿を見て「今どの作業ファイルか」を決めるので、
  //   あとから戻すと、既定以外を開いていた人が既定に戻されてしまう。
  if (opts.seed && opts.seed.length) node.fs._restore(opts.seed);

  // package.json は「読まれるファイル」なので、置き場所へ置いておく。
  if (sources[PACKAGE_FILE] != null) {
    node.fs.writeFileSync('/app/' + PACKAGE_FILE, sources[PACKAGE_FILE]);
  }
  // 画面のファイルも同じ場所へ置く（配布用 HTML がこれを読む）。
  for (const rel of PAGE_FILES) {
    const body = sources['public/' + rel];
    if (body != null) node.fs.writeFileSync('/app/public/' + rel, body);
  }

  // lib を先に評価して、require で引けるように登録する
  for (const lib of LIB_ORDER) {
    const src = sources[lib.file];
    if (src == null) throw new Error('同梱されていません: ' + lib.file);
    const exported = evalModule(src, lib.file, env);
    node.registry[lib.key] = exported;
    node.registry['lib/' + lib.key] = exported;
    node.registry['./lib/' + lib.key] = exported;
    node.registry['./' + lib.key] = exported;
  }

  const serverSrc = sources[SERVER_FILE];
  if (serverSrc == null) throw new Error('同梱されていません: ' + SERVER_FILE);
  const exported = evalModule(serverSrc, SERVER_FILE, env);

  if (!exported || !exported.app) {
    throw new Error('server.js が app を返しませんでした（MD_EDITOR_EMBEDDED が渡っているか確認）');
  }
  return { app: exported.app, fs: node.fs, process: node.process };
}

global.LoadServer = { fetchSources, create, LIB_ORDER, SERVER_FILE, PAGE_FILES };

})(typeof self !== 'undefined' ? self : this);
