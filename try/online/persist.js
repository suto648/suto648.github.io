/*
 * オンライン版の保存先（ブラウザの IndexedDB）。
 *
 * 役割は2つだけ:
 *   起動時  … 保存してあるものを全部読み出して、メモリのファイル置き場へ戻す
 *   変更時  … 1ファイルぶんを書き込む／消す
 *
 * ★なぜ localStorage ではないか
 *   画像を base64 で持つので、localStorage の 5MB ではすぐ足りなくなる。
 *   足りなくなったときに黙って保存が落ちるのがいちばん困る。
 *
 * ★なぜメモリに全部載せるか
 *   IndexedDB は非同期しか無い。非同期を lib や server.js に持ち込むと、
 *   オフライン版まで async に染めることになる。
 *   起動時に1回だけ全部読み、読みはメモリから返す（lib/VFS-CONTRACT.md）。
 *
 * ★書き込みは待たない（が、順番は守る）
 *   保存のたびに待つと入力が重くなる。順番だけ守って流す。
 *   タブを閉じる直前の1回が落ちる可能性は残るので、
 *   本文の保存が終わった印（保存済み）は、メモリに入った時点ではなく
 *   IndexedDB へ入った時点に合わせたい ── そこは flush() で待てるようにしてある。
 */
(function (global) {
'use strict';

const DB_NAME = 'yarubeki-editor';
const DB_VERSION = 1;
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function createPersist() {
  let db = null;
  let queue = Promise.resolve();   // 書き込みの順番を守るための一本道
  let broken = null;               // 保存できなくなった理由（画面に出す）

  let persistAsked = null;   // true=申告できた / false=断られた / null=申告する口が無い

  async function boot() {
    try {
      // 「後で勝手に消さないでほしい」と申告しておく。断られても動く。
      // ★Safari にはこの申告の口が無い（実測: navigator.storage.persist が未定義）。
      //   そして Safari は「7日間そのサイトを触らないと、書いたものを自動で消す」。
      //   （出典: webkit.org のブログ「Full Third-Party Cookie Blocking and More」。
      //     ホーム画面に追加したものは Safari の外なので対象外）
      //   申告できたかどうかを覚えておき、できなかったときは画面で伝える。
      if (navigator.storage && navigator.storage.persist) {
        try { persistAsked = await navigator.storage.persist(); } catch (_) { persistAsked = false; }
      }
      db = await openDb();
    } catch (e) {
      broken = 'この閲覧環境では保存できません（' + (e && e.name || 'エラー') + '）。' +
               'プライベートウィンドウでは保存が使えないことがあります。';
      return [];
    }
    return await readAll();
  }

  function readAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).map(row => ({
        name: row.name,
        rec: { text: row.text, b64: row.b64, mtime: row.mtime ? new Date(row.mtime) : new Date() }
      })));
      req.onerror = () => reject(req.error);
    });
  }

  // fs の変更をそのまま受ける形（name, rec）。rec が null なら削除。
  function onChange(name, rec) {
    if (!db) return;
    queue = queue.then(() => new Promise((resolve) => {
      let tx;
      try { tx = db.transaction(STORE, 'readwrite'); }
      catch (e) { broken = '保存に失敗しました: ' + (e && e.message); return resolve(); }
      const store = tx.objectStore(STORE);
      try {
        if (rec === null) store.delete(name);
        else store.put({
          name,
          text: rec.text,
          b64: rec.b64,
          mtime: (rec.mtime instanceof Date ? rec.mtime : new Date()).toISOString()
        });
      } catch (e) {
        broken = '保存に失敗しました: ' + (e && e.message);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        // 容量切れはここに来る。黙って落とさず、理由を残す。
        broken = (tx.error && tx.error.name === 'QuotaExceededError')
          ? 'ブラウザの保存容量がいっぱいです。画像を減らすか、書き出して保存してください。'
          : '保存に失敗しました: ' + (tx.error && tx.error.message || '原因不明');
        resolve();
      };
      tx.onabort = () => resolve();
    }));
  }

  // 書き込みが全部片付くまで待つ
  function flush() { return queue; }

  async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      const e = await navigator.storage.estimate();
      return { used: e.usage, quota: e.quota };
    } catch (_) { return null; }
  }

  async function clearAll() {
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  return {
    boot, onChange, flush, usage, clearAll,
    get problem() { return broken; },
    // 保存を守ってほしいと申告できたか（できなかった＝自動で消されうる）
    get persistGranted() { return persistAsked; }
  };
}

global.OnlinePersist = { createPersist };

})(typeof self !== 'undefined' ? self : this);
