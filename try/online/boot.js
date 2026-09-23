/*
 * オンライン版の起動。
 *
 * やること:
 *   1. /api/* と /images/* への通信を、この場で横取りする口を先に立てる
 *      （app.js は読み込んだ直後に通信を始めるので、先に立てておかないと間に合わない）
 *   2. 保存してあるものを読み出し、同梱の server.js をそのまま動かす
 *   3. 横取りした要求を、その server.js に処理させる
 *
 * ★サービスワーカーを使わない理由
 *   無料お試しの入口で「たまに古い版が出る」のは致命的。
 *   サービスワーカーは初回読み込みの競合と更新の反映が厄介なので、
 *   素直に fetch を差し替える。
 */
(function (global) {
'use strict';

const HANDLED = /^\/(api|images)\//;

// ここに来るまでの要求は待たせる
let ready = null;
let engine = null;
let persist = null;
let bootError = null;

const realFetch = global.fetch.bind(global);

function toResponse(out) {
  const headers = new Headers(out.headers || {});
  if (out.base64) {
    const bin = atob(out.body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status: out.status, headers });
  }
  return new Response(out.body, { status: out.status, headers });
}

global.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  let pathname;
  try { pathname = new URL(url, location.href).pathname; } catch (_) { pathname = ''; }

  if (!HANDLED.test(pathname)) return realFetch(input, init);

  if (ready) await ready;
  if (bootError) {
    return new Response(JSON.stringify({ error: bootError }), {
      status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  const opt = init || (typeof input === 'object' ? input : {}) || {};
  const method = String(opt.method || 'GET').toUpperCase();
  let body = opt.body;
  if (body && typeof body !== 'string') {
    try { body = await new Response(body).text(); } catch (_) { body = ''; }
  }

  const out = await engine.app.handle(method, new URL(url, location.href).href, body);
  if (!out) return realFetch(input, init);

  // 本文を保存する要求は、ブラウザの保存領域へ書き終わってから返す。
  // ここで待たないと「保存済み」と出したのに、タブを閉じた瞬間の1回が消える。
  if (method === 'PUT' || method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    await persist.flush();
  }
  return toResponse(out);
};

// ---- ここから起動 ----
ready = (async function start() {
  try {
    persist = global.OnlinePersist.createPersist();
    const rows = await persist.boot();

    // 第2引数は画面のファイル（style.css など）の置き場所。
    // 配布用 HTML を作るとき、server.js がこれらをファイルとして読む。
    const sources = await global.LoadServer.fetchSources(
      (global.YARUBEKI_ONLINE_BASE || './engine/'), './');

    engine = global.LoadServer.create(sources, {
      env: { MD_EDITOR_DATA: '/data', MD_EDITOR_EMBEDDED: '1' },
      onChange: (name, rec) => persist.onChange(name, rec),
      // 保存してあったものは server.js を読む前に戻す（load-server.js の注記参照）
      seed: rows
    });

    global.YarubekiOnline = {
      engine, persist,
      // 設定画面から呼ぶための口
      usage: () => persist.usage(),
      wipe: async () => { await persist.clearAll(); location.reload(); },
      problem: () => persist.problem,
      persistGranted: () => persist.persistGranted
    };
  } catch (e) {
    bootError = 'オンライン版の起動に失敗しました: ' + (e && e.message || e);
    console.error(e);
  }
})();

global.__YARUBEKI_ONLINE__ = true;

})(typeof self !== 'undefined' ? self : this);
