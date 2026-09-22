/*
 * ブラウザの中で server.js をそのまま動かすための、ごく薄い Node 互換層。
 *
 * ★なぜ「書き写す」のではなく「そのまま動かす」のか
 *   本日更新・履歴・整理モードの計算は、この製品の値打ちそのもの。
 *   オンライン版のために同じ計算をもう一度書けば、必ずどこかでずれる。
 *   ずれても画面は普通に動くので、誰も気づかないまま出荷することになる。
 *   server.js が使っている外部の機能を数えたら、
 *     fs 9個 / path 4個 / os 1個 / express 6個
 *   しか無かった。それならこちらを用意したほうが、写すより安全で短い。
 *
 * ここが受け持つもの:
 *   path    join / dirname / basename / extname
 *   fs      existsSync / readFileSync / writeFileSync / readdirSync /
 *           mkdirSync / unlinkSync / statSync / renameSync / copyFileSync
 *   os      hostname
 *   express ルーティングと静的配信（req.query/body/params、res.json/status/send/setHeader）
 *   Buffer  base64 の行き来だけ（画像用）
 *
 * ファイルの中身はメモリに持つ。IndexedDB への保存は online/persist.js が受け持つ
 * （ここは保存先を知らない。変更があったら onChange を呼ぶだけ）。
 */
(function (global) {
'use strict';

// ===== path ==============================================================
// 区切りは必ず "/"。Windows の "\" は最初に潰す。
function normalize(p) {
  const abs = p.startsWith('/');
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); continue; }
    parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/');
}

const pathShim = {
  sep: '/',
  join: function () {
    return normalize(Array.prototype.filter.call(arguments, x => x != null && x !== '').join('/'));
  },
  dirname: function (p) {
    const n = normalize(p);
    const i = n.lastIndexOf('/');
    if (i < 0) return '.';
    if (i === 0) return '/';
    return n.slice(0, i);
  },
  basename: function (p, ext) {
    const n = normalize(p);
    let b = n.slice(n.lastIndexOf('/') + 1);
    if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
    return b;
  },
  extname: function (p) {
    const b = pathShim.basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  },
  resolve: function () { return pathShim.join.apply(null, arguments); }
};

// ===== Buffer（base64 の行き来だけ）=======================================
// 画像は data URL の base64 のまま持ち回る。中身を解く必要がないので、
// 「base64 の文字列を包んだもの」で足りる。
function Bufferish(b64) { this._b64 = b64; }
Bufferish.prototype.toString = function (enc) {
  if (enc === 'base64') return this._b64;
  // base64 以外で読もうとするのは想定外。壊れた文字を返すより空を返す。
  return '';
};
Object.defineProperty(Bufferish.prototype, 'length', {
  get: function () { return Math.floor(this._b64.length * 3 / 4); }
});
const BufferShim = {
  from: function (data, enc) {
    if (data instanceof Bufferish) return data;
    if (enc === 'base64') return new Bufferish(String(data));
    return new Bufferish(global.btoa(unescape(encodeURIComponent(String(data)))));
  },
  isBuffer: function (x) { return x instanceof Bufferish; }
};

// ===== fs（メモリ）========================================================
function createFs(options) {
  const opts = options || {};
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};

  // name -> { text, b64, mtime }   text と b64 はどちらか一方
  const files = new Map();
  const dirs = new Set(['/']);

  function addDirs(file) {
    let d = pathShim.dirname(file);
    while (d && d !== '/' && !dirs.has(d)) { dirs.add(d); d = pathShim.dirname(d); }
  }

  const fs = {
    // --- 読み書き ---
    existsSync(p) {
      const n = normalize(p);
      return files.has(n) || dirs.has(n);
    },
    readFileSync(p, enc) {
      const n = normalize(p);
      const rec = files.get(n);
      if (!rec) { const e = new Error("ENOENT: no such file or directory, open '" + n + "'"); e.code = 'ENOENT'; throw e; }
      if (enc) return rec.text != null ? rec.text : (rec.b64 ? global.atob(rec.b64) : '');
      return new Bufferish(rec.b64 != null ? rec.b64 : BufferShim.from(rec.text || '')._b64);
    },
    writeFileSync(p, data) {
      const n = normalize(p);
      addDirs(n);
      const rec = (data instanceof Bufferish)
        ? { b64: data._b64, mtime: new Date() }
        : { text: String(data), mtime: new Date() };
      files.set(n, rec);
      onChange(n, rec);
    },
    unlinkSync(p) {
      const n = normalize(p);
      if (!files.has(n)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(n);
      onChange(n, null);
    },
    renameSync(from, to) {
      const a = normalize(from), b = normalize(to);
      if (files.has(a)) {
        const rec = files.get(a);
        files.delete(a); addDirs(b); files.set(b, rec);
        onChange(a, null); onChange(b, rec);
        return;
      }
      // フォルダごとの移動（作業ファイルを退避するときに使われる）
      if (dirs.has(a)) {
        const prefix = a + '/';
        for (const key of Array.from(files.keys())) {
          if (key === a || key.startsWith(prefix)) {
            const rec = files.get(key);
            const dest = b + key.slice(a.length);
            files.delete(key); addDirs(dest); files.set(dest, rec);
            onChange(key, null); onChange(dest, rec);
          }
        }
        dirs.delete(a); dirs.add(b);
        return;
      }
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    copyFileSync(from, to) {
      const rec = files.get(normalize(from));
      if (!rec) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      const b = normalize(to);
      const copy = Object.assign({}, rec, { mtime: new Date() });
      addDirs(b); files.set(b, copy);
      onChange(b, copy);
    },
    mkdirSync(p) { const n = normalize(p); dirs.add(n); addDirs(n + '/x'); },
    readdirSync(p) {
      const n = normalize(p);
      const prefix = n === '/' ? '/' : n + '/';
      const out = new Set();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const i = rest.indexOf('/');
        out.add(i < 0 ? rest : rest.slice(0, i));
      }
      for (const d of dirs) {
        if (d !== n && d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const i = rest.indexOf('/');
          out.add(i < 0 ? rest : rest.slice(0, i));
        }
      }
      return Array.from(out);
    },
    statSync(p) {
      const n = normalize(p);
      const rec = files.get(n);
      if (rec) {
        const mtime = rec.mtime instanceof Date ? rec.mtime : new Date(rec.mtime || Date.now());
        return {
          mtime,
          // ★mtimeMs も返す。server.js の版トークンはこちらを使っており、
          //   無いと NaN になって「別PCが更新した」の判定が壊れる。
          mtimeMs: mtime.getTime(),
          size: rec.text != null ? rec.text.length : (rec.b64 ? rec.b64.length : 0),
          isDirectory: () => false, isFile: () => true
        };
      }
      if (dirs.has(n)) {
        const now = new Date();
        return { mtime: now, mtimeMs: now.getTime(), size: 0,
                 isDirectory: () => true, isFile: () => false };
      }
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    rmSync(p, o) {
      const n = normalize(p);
      if (o && o.recursive) {
        const prefix = n + '/';
        for (const key of Array.from(files.keys())) {
          if (key === n || key.startsWith(prefix)) { files.delete(key); onChange(key, null); }
        }
        for (const d of Array.from(dirs)) if (d === n || d.startsWith(prefix)) dirs.delete(d);
        return;
      }
      if (files.has(n)) { files.delete(n); onChange(n, null); }
    },

    // --- 保存層との受け渡し（server.js からは使わない）---
    _dump() {
      const out = [];
      for (const [name, rec] of files) out.push({ name, rec });
      return out;
    },
    _restore(rows) {
      for (const row of rows || []) {
        const n = normalize(row.name);
        addDirs(n);
        files.set(n, row.rec);
      }
    },
    _files: files,
    _dirs: dirs
  };
  return fs;
}

// ===== express ============================================================
// 使われているのは app.get/post/put/patch/delete/use と
// req.query/body/params、res.json/status/send/setHeader だけ。
function createExpress(fs) {
  function express() {
    const routes = [];     // { method, pattern, keys, handler }
    const middles = [];    // { prefix, fn }

    function addRoute(method, pattern, handler) {
      const keys = [];
      const rx = new RegExp('^' + pattern
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/:(\w+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      routes.push({ method, rx, keys, handler });
    }

    const app = {
      get: (p, h) => addRoute('GET', p, h),
      post: (p, h) => addRoute('POST', p, h),
      put: (p, h) => addRoute('PUT', p, h),
      patch: (p, h) => addRoute('PATCH', p, h),
      delete: (p, h) => addRoute('DELETE', p, h),
      use: function (a, b) {
        if (typeof a === 'string') middles.push({ prefix: a, fn: b });
        else middles.push({ prefix: '', fn: a });
      },
      listen: function () { throw new Error('ブラウザでは待ち受けない'); },

      /**
       * 1件の要求を処理する。見つからなければ null を返す（呼ぶ側が本物の通信へ回す）。
       * @returns {Promise<{status:number, headers:object, body:string}|null>}
       */
      handle: async function (method, url, bodyText) {
        const u = new URL(url, 'http://local');
        const pathname = decodeURIComponent(u.pathname);

        // 静的配信（/images/... など）
        for (const m of middles) {
          if (!m.fn || !m.fn.__staticDir) continue;
          if (m.prefix && !pathname.startsWith(m.prefix)) continue;
          const rel = m.prefix ? pathname.slice(m.prefix.length) : pathname;
          const file = pathShim.join(m.fn.__staticDir, rel);
          if (rel && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
            const rec = fs._files.get(normalize(file));
            if (rec && rec.b64) {
              return { status: 200, headers: { 'Content-Type': guessMime(file) },
                       body: rec.b64, base64: true };
            }
            return { status: 200, headers: { 'Content-Type': guessMime(file) },
                     body: fs.readFileSync(file, 'utf-8') };
          }
        }

        for (const r of routes) {
          if (r.method !== method) continue;
          const m = pathname.match(r.rx);
          if (!m) continue;

          const req = {
            method, path: pathname, url,
            params: {}, query: {},
            body: parseBody(bodyText),
            headers: {}
          };
          r.keys.forEach((k, i) => { req.params[k] = m[i + 1]; });
          u.searchParams.forEach((v, k) => { req.query[k] = v; });

          const out = { status: 200, headers: {}, body: '' };
          let done, fail;
          const finished = new Promise((res, rej) => { done = res; fail = rej; });
          const res = {
            status(n) { out.status = n; return res; },
            setHeader(k, v) { out.headers[k] = v; return res; },
            json(obj) {
              out.headers['Content-Type'] = 'application/json; charset=utf-8';
              out.body = JSON.stringify(obj);
              done(out); return res;
            },
            send(text) {
              if (!out.headers['Content-Type']) out.headers['Content-Type'] = 'text/plain; charset=utf-8';
              out.body = String(text);
              done(out); return res;
            },
            end() { done(out); return res; }
          };

          try {
            const ret = r.handler(req, res);
            if (ret && typeof ret.then === 'function') ret.catch(fail);
          } catch (e) { fail(e); }
          return await finished;
        }
        return null;
      }
    };
    return app;
  }

  express.json = function () { return function () {}; };
  express.static = function (dir) {
    const fn = function () {};
    fn.__staticDir = dir;
    return fn;
  };
  return express;
}

function parseBody(bodyText) {
  if (bodyText == null || bodyText === '') return {};
  try { return JSON.parse(bodyText); } catch (_) { return {}; }
}

function guessMime(file) {
  const ext = pathShim.extname(file).slice(1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'js') return 'text/javascript; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (ext === 'html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

// ===== require の名簿 =====================================================
/**
 * server.js を動かすための一式を作る。
 * @param {object} config  { env, modules }  env は process.env の中身、
 *                         modules は './lib/...' で引ける追加のモジュール
 */
function createNodeEnv(config) {
  const cfg = config || {};
  const fs = createFs({ onChange: cfg.onChange });
  const express = createExpress(fs);

  const processShim = {
    env: Object.assign({
      MD_EDITOR_EMBEDDED: '1',     // 待ち受け・ショートカット・在席ファイルを動かさない目印
      MD_EDITOR_NO_OPEN: '1',
      MD_EDITOR_NO_SHORTCUT: '1'
    }, cfg.env || {}),
    platform: 'browser',
    pid: 1,
    argv: ['node', '/app/server.js'],
    execPath: 'node',
    cwd: () => '/app',
    on: () => {},
    exit: () => {},
    nextTick: (fn) => Promise.resolve().then(fn),
    stdout: { write: () => {} },
    versions: { node: '0.0.0-browser' }
  };

  const registry = {
    fs: fs,
    path: pathShim,
    os: { hostname: () => 'browser', tmpdir: () => '/tmp', platform: () => 'browser' },
    express: express,
    http: { get: () => { throw new Error('ブラウザでは外へ出ない'); } },
    net: {},
    child_process: { spawn: () => {}, exec: () => {}, execFile: () => {} },
    url: { pathToFileURL: (p) => ({ href: 'file://' + p }) }
  };
  Object.assign(registry, cfg.modules || {});

  function requireShim(name) {
    if (registry[name]) return registry[name];
    // './lib/xxx' → 'lib/xxx' でも引けるようにする
    const key = String(name).replace(/^\.\//, '').replace(/\.js$/, '');
    if (registry[key]) return registry[key];
    throw new Error('ブラウザ側に用意していないモジュール: ' + name);
  }

  return { fs, path: pathShim, express, process: processShim, require: requireShim,
           Buffer: BufferShim, registry };
}

global.NodeShim = {
  createNodeEnv: createNodeEnv,
  createFs: createFs,
  path: pathShim,
  Buffer: BufferShim,
  normalize: normalize
};

})(typeof self !== 'undefined' ? self : this);
