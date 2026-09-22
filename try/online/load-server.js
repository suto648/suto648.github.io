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

async function fetchSources(baseUrl) {
  const base = String(baseUrl || './').replace(/\/?$/, '/');
  const out = {};
  const wanted = LIB_ORDER.map(l => l.file).concat([SERVER_FILE, PACKAGE_FILE]);
  await Promise.all(wanted.map(async (rel) => {
    const res = await fetch(base + rel, { cache: 'no-cache' });
    if (!res.ok) throw new Error('読み込めません: ' + rel + '（' + res.status + '）');
    out[rel] = await res.text();
  }));
  return out;
}

// CommonJS の1ファイルを、与えた道具立てのもとで評価する。
function evalModule(source, fileName, env) {
  const module = { exports: {} };
  const fn = new Function(
    'require', 'module', 'exports', '__dirname', '__filename',
    'process', 'Buffer', 'console', 'setInterval', 'clearInterval',
    'setTimeout', 'clearTimeout', 'URL', 'self',
    source + '\n//# sourceURL=' + fileName
  );
  fn(env.require, module, module.exports, '/app', '/app/' + fileName,
     env.process, env.Buffer, console, env.setInterval, env.clearInterval,
     env.setTimeout, env.clearTimeout, URL, undefined);
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

global.LoadServer = { fetchSources, create, LIB_ORDER, SERVER_FILE };

})(typeof self !== 'undefined' ? self : this);
