// ==UserScript==
// @name         PTT term.ptt.cc 名單功能 (好友/黑名單/備註)
// @namespace    ptt-term-namelist
// @version      1.6.0
// @description  在 term.ptt.cc 右鍵選單加入「加入名單/編輯名單/取消名單」功能，可標記好友、黑名單、備註，資料存在本機瀏覽器(Tampermonkey storage)，並可選擇透過 GitHub Gist 跨裝置同步
// @match        https://term.ptt.cc/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @updateURL    https://raw.githubusercontent.com/charles0506/ptt-term-namelist/master/ptt-term-namelist.user.js
// @downloadURL  https://raw.githubusercontent.com/charles0506/ptt-term-namelist/master/ptt-term-namelist.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Tampermonkey runs @grant scripts in an isolated JS world; the page's own
  // globals (window.app, window.lib set by ptt-term) are only reachable via
  // unsafeWindow there. Fall back to window for engines without it (Firefox
  // legacy GM, or when injected directly into the page for testing).
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const STORAGE_KEY = 'pttTermNameList_v1';
  const TOKEN_KEY = 'pttTermNameList_ghToken';
  const GISTID_KEY = 'pttTermNameList_gistId';
  const GIST_FILENAME = 'ptt-term-namelist.json';
  const AUTOLOGIN_KEY = 'pttTermNameList_autoLogin';

  const TYPE_META = {
    friend: { label: '好友', color: '#2ecc71' },
    block: { label: '黑名單', color: '#4a148c' },
    note: { label: '其他', color: '#f1c40f' },
  };

  // ---------- local storage ----------
  function loadList() {
    try {
      return GM_getValue(STORAGE_KEY, {}) || {};
    } catch (e) {
      return {};
    }
  }

  function saveList(list) {
    try {
      GM_setValue(STORAGE_KEY, list);
    } catch (e) {
      /* ignore */
    }
  }

  function upsertEntry(id, type, note) {
    const list = loadList();
    list[id] = { type, note: note || '', updatedAt: Date.now() };
    saveList(list);
    schedulePush();
  }

  function removeEntry(id) {
    const list = loadList();
    delete list[id];
    saveList(list);
    schedulePush();
  }

  // Parses free-form pasted text: one ID per line, or separated by commas/
  // whitespace/full-width commas. Non-ID tokens are silently skipped.
  function parseIdsFromText(text) {
    if (!text) return [];
    const tokens = text.split(/[\s,，、;]+/);
    const seen = new Set();
    const ids = [];
    for (const t of tokens) {
      const m = t.match(/^[A-Za-z][A-Za-z0-9_]{1,11}$/);
      if (m && !seen.has(m[0])) {
        seen.add(m[0]);
        ids.push(m[0]);
      }
    }
    return ids;
  }

  function bulkImport(type, text) {
    const ids = parseIdsFromText(text);
    if (ids.length === 0) return 0;
    const list = loadList();
    const now = Date.now();
    for (const id of ids) {
      const existing = list[id];
      list[id] = { type, note: existing ? existing.note : '', updatedAt: now };
    }
    saveList(list);
    schedulePush();
    return ids.length;
  }

  // ---------- cloud sync (GitHub Gist) ----------
  function getToken() {
    try {
      return GM_getValue(TOKEN_KEY, '') || '';
    } catch (e) {
      return '';
    }
  }
  function setToken(t) {
    try {
      GM_setValue(TOKEN_KEY, t || '');
    } catch (e) {
      /* ignore */
    }
  }
  function getGistId() {
    try {
      return GM_getValue(GISTID_KEY, '') || '';
    } catch (e) {
      return '';
    }
  }
  function setGistId(id) {
    try {
      GM_setValue(GISTID_KEY, id || '');
    } catch (e) {
      /* ignore */
    }
  }

  function getAutoLogin() {
    try {
      return GM_getValue(AUTOLOGIN_KEY, true) !== false;
    } catch (e) {
      return true;
    }
  }
  function setAutoLogin(v) {
    try {
      GM_setValue(AUTOLOGIN_KEY, !!v);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- auto-login ----------
  // Only clicks term.ptt.cc's own "登入" button once the browser's own
  // password-manager autofill has already populated both fields. Never
  // reads, stores, or transmits the credential values themselves.
  function setupAutoLogin() {
    // Keep polling for as long as the modal stays open instead of giving up
    // after a fixed timeout -- browser autofill can take longer than a couple
    // seconds to populate, especially right after page load.
    let watching = null; // { modal, timer }
    const stopWatch = () => {
      if (watching) {
        clearInterval(watching.timer);
        watching = null;
      }
    };
    const watch = (modal) => {
      if (watching && watching.modal === modal) return;
      stopWatch();
      const userInput = modal.querySelector('#site-login-username');
      const passInput = modal.querySelector('#site-login-password');
      const submitBtn = modal.querySelector('.LoginModal__Btn--submit');
      if (!userInput || !passInput || !submitBtn) return;
      const timer = setInterval(() => {
        if (!getAutoLogin() || !document.body.contains(modal) || modal.open === false) {
          stopWatch();
          return;
        }
        if (userInput.value && passInput.value) {
          stopWatch();
          submitBtn.click();
        }
      }, 200);
      watching = { modal, timer };
    };
    const observer = new MutationObserver(() => {
      if (!getAutoLogin()) return;
      const modal = document.querySelector('.LoginModal');
      if (modal) watch(modal);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    const initial = document.querySelector('.LoginModal');
    if (initial) watch(initial);
  }

  function ghRequest(method, url, token, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('此瀏覽器/擴充套件不支援 GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res);
          else reject(new Error(`GitHub API ${res.status}: ${(res.responseText || '').slice(0, 200)}`));
        },
        onerror: () => reject(new Error('網路錯誤')),
        ontimeout: () => reject(new Error('連線逾時')),
      });
    });
  }

  async function ensureGistId(token) {
    const existing = getGistId();
    if (existing) return existing;
    const listRes = await ghRequest('GET', 'https://api.github.com/gists?per_page=100', token);
    const gists = JSON.parse(listRes.responseText);
    const found = gists.find((g) => g.files && g.files[GIST_FILENAME]);
    if (found) {
      setGistId(found.id);
      return found.id;
    }
    const createRes = await ghRequest('POST', 'https://api.github.com/gists', token, {
      description: 'ptt-term-namelist data (由 userscript 自動管理，請勿更改檔名)',
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({}) } },
    });
    const created = JSON.parse(createRes.responseText);
    setGistId(created.id);
    return created.id;
  }

  // last-write-wins per entry by updatedAt; note: deletions do not propagate (known limitation)
  function mergeLists(local, remote) {
    const merged = { ...remote };
    for (const id of Object.keys(local)) {
      const l = local[id];
      const r = remote[id];
      if (!r || (l.updatedAt || 0) >= (r.updatedAt || 0)) merged[id] = l;
    }
    return merged;
  }

  async function pullFromCloud() {
    const token = getToken();
    if (!token) throw new Error('尚未設定 Token');
    const gistId = await ensureGistId(token);
    const res = await ghRequest('GET', `https://api.github.com/gists/${gistId}`, token);
    const gist = JSON.parse(res.responseText);
    const file = gist.files && gist.files[GIST_FILENAME];
    let remote = {};
    if (file && file.content) {
      try {
        remote = JSON.parse(file.content) || {};
      } catch (e) {
        remote = {};
      }
    }
    const merged = mergeLists(loadList(), remote);
    saveList(merged);
    return merged;
  }

  async function pushToCloud(list) {
    const token = getToken();
    if (!token) return;
    const gistId = await ensureGistId(token);
    await ghRequest('PATCH', `https://api.github.com/gists/${gistId}`, token, {
      files: { [GIST_FILENAME]: { content: JSON.stringify(list || loadList()) } },
    });
  }

  let pushTimer = null;
  function schedulePush() {
    if (!getToken()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushToCloud(loadList()).catch((e) => console.warn('[ptt-term-namelist] 自動同步失敗', e));
    }, 800);
  }

  // ---------- terminal text / hit-testing ----------
  const ID_RE = /[A-Za-z][A-Za-z0-9_]{1,11}/g;

  function buildRowString(app, row) {
    const buf = app.buf;
    const line = buf.lines && buf.lines[row];
    if (!line) return '';
    let s = '';
    for (let c = 0; c < buf.cols; c++) {
      const cell = line[c];
      if (!cell || cell.isDBCSTrail || cell.ch === '' || cell.ch === undefined) {
        s += ' ';
      } else {
        s += cell.ch;
      }
    }
    return s;
  }

  function getIdAtPagePos(pageX, pageY) {
    const app = pageWindow.app;
    if (!app || !app.view || !app.buf) return null;
    if (typeof pageX !== 'number' || typeof pageY !== 'number') return null;
    const clientX = pageX - window.scrollX;
    const clientY = pageY - window.scrollY;
    let pos;
    try {
      pos = app.view.clientToPos(clientX, clientY);
    } catch (e) {
      return null;
    }
    if (!pos) return null;
    const rowStr = buildRowString(app, pos.row);
    if (!rowStr) return null;
    ID_RE.lastIndex = 0;
    let m;
    while ((m = ID_RE.exec(rowStr))) {
      const start = m.index;
      const end = start + m[0].length;
      if (pos.col >= start && pos.col < end) return m[0];
    }
    return null;
  }

  // shared between visible()/label() calls within the same menu render pass
  let clickCtx = { id: null, entry: null };

  function computeClickCtx(f) {
    const id = getIdAtPagePos(f.pageX, f.pageY);
    const entry = id ? loadList()[id] || null : null;
    clickCtx = { id, entry };
    return clickCtx;
  }

  // ---------- on-screen highlight ----------
  // Marks every occurrence of a listed ID directly on the terminal grid with a
  // colored underline, positioned the same way ptt-term positions its own
  // invisible hyperlink overlays (col*chw, row*chh inside #mainContainer).
  // pointer-events:none so it never steals clicks meant for the canvas.
  let highlightEls = [];
  function clearHighlights() {
    highlightEls.forEach((el) => el.remove());
    highlightEls = [];
  }

  function renderHighlights(app) {
    const list = loadList();
    const ids = Object.keys(list);
    const mainContainer = document.querySelector('#mainContainer');
    if (!mainContainer || ids.length === 0) {
      clearHighlights();
      return;
    }
    const buf = app.buf;
    const view = app.view;
    const chw = view.chw * (view.scaleX || 1);
    const chh = view.chh * (view.scaleY || 1);
    const boxes = [];
    for (let row = 0; row < buf.rows; row++) {
      const rowStr = buildRowString(app, row);
      if (!rowStr.trim()) continue;
      ID_RE.lastIndex = 0;
      let m;
      while ((m = ID_RE.exec(rowStr))) {
        const entry = list[m[0]];
        if (entry) {
          const meta = TYPE_META[entry.type] || TYPE_META.note;
          boxes.push({ row, col: m.index, len: m[0].length, color: meta.color });
        }
      }
    }
    while (highlightEls.length < boxes.length) {
      const el = document.createElement('div');
      el.className = 'pnl-highlight';
      mainContainer.appendChild(el);
      highlightEls.push(el);
    }
    while (highlightEls.length > boxes.length) {
      highlightEls.pop().remove();
    }
    boxes.forEach((b, i) => {
      const el = highlightEls[i];
      el.style.left = b.col * chw + 'px';
      el.style.top = b.row * chh + 'px';
      el.style.width = b.len * chw + 'px';
      el.style.height = chh + 'px';
      // mix-blend-mode:color recolors the bright text glyphs underneath to
      // this hue while leaving the near-black background alone, so it reads
      // as the ID's actual text changing color rather than a box on top of it.
      el.style.background = b.color;
      el.style.mixBlendMode = 'color';
      el.style.borderBottom = 'none';
      el.style.boxShadow = 'none';
    });
  }

  function startHighlightLoop() {
    setInterval(() => {
      const app = pageWindow.app;
      if (app && app.buf && app.view) renderHighlights(app);
    }, 350);
  }

  // ---------- UI: modal dialog ----------
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      /* native <dialog>+showModal() renders in the browser's top layer and makes
         the rest of the page inert, which is the only thing that reliably beats
         term.ptt.cc's own window-level mouse capture for the terminal grid. */
      dialog.pnl-dialog { background: #1e1e1e; color: #eee; border: none; border-radius: 8px; padding: 16px 20px; width: 320px; max-width: 90vw; box-shadow: 0 8px 30px rgba(0,0,0,.5); font-family: -apple-system, "Microsoft JhengHei", sans-serif; }
      dialog.pnl-dialog::backdrop { background: rgba(0,0,0,.5); }
      dialog.pnl-dialog.pnl-dialog-wide { width: 440px; }
      .pnl-box h3 { margin: 0 0 10px; font-size: 16px; }
      .pnl-row { margin-bottom: 10px; }
      .pnl-row label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; }
      .pnl-row input[type=text] { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid #444; background: #111; color: #eee; }
      .pnl-types { display: flex; gap: 8px; }
      .pnl-types label { display: flex; align-items: center; gap: 4px; font-size: 13px; color: #eee; cursor: pointer; }
      .pnl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .pnl-btn { padding: 6px 14px; border-radius: 4px; border: none; cursor: pointer; font-size: 13px; }
      .pnl-btn.save { background: #2d7ff9; color: #fff; }
      .pnl-btn.cancel { background: #444; color: #eee; }
      .pnl-btn.del { background: #e74c3c; color: #fff; margin-right: auto; }
      .pnl-manage-list { max-height: 320px; overflow-y: auto; margin: 10px 0; }
      .pnl-manage-item { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #333; font-size: 13px; }
      .pnl-manage-item .tag { padding: 1px 6px; border-radius: 3px; font-size: 11px; color: #111; font-weight: bold; }
      .pnl-manage-item .id { font-weight: bold; min-width: 90px; }
      .pnl-manage-item .note { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pnl-manage-item .mini-btn { padding: 2px 8px; font-size: 11px; border-radius: 3px; border: 1px solid #555; background: #2a2a2a; color: #eee; cursor: pointer; }
      .pnl-cloud { border: 1px solid #333; border-radius: 6px; padding: 10px; margin-bottom: 10px; }
      .pnl-cloud-title { font-size: 13px; font-weight: bold; margin-bottom: 8px; }
      .pnl-cloud input[type=password] { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid #444; background: #111; color: #eee; margin-bottom: 8px; font-family: monospace; }
      .pnl-cloud-actions { display: flex; gap: 8px; margin-bottom: 6px; }
      .pnl-cloud-status { font-size: 12px; color: #999; }
      .pnl-toggle-row { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 10px; }
      #pttNameListFab { position: fixed; right: 14px; bottom: 14px; z-index: 999998; background: #2d7ff9cc; color: #fff; border-radius: 20px; padding: 8px 14px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); font-family: -apple-system, "Microsoft JhengHei", sans-serif; user-select: none; }
      #pttNameListFab:hover { background: #2d7ff9; }
      .pnl-highlight { position: absolute; pointer-events: none; box-sizing: border-box; z-index: 3; }
      .pnl-import { border: 1px solid #333; border-radius: 6px; padding: 10px; margin-bottom: 10px; }
      .pnl-import-title { font-size: 13px; font-weight: bold; margin-bottom: 8px; }
      .pnl-import-cols { display: flex; gap: 8px; }
      .pnl-import-col { flex: 1; display: flex; flex-direction: column; }
      .pnl-import-col label { font-size: 12px; color: #aaa; margin-bottom: 4px; }
      .pnl-import-col textarea { width: 100%; box-sizing: border-box; height: 70px; resize: vertical; padding: 6px 8px; border-radius: 4px; border: 1px solid #444; background: #111; color: #eee; font-family: monospace; font-size: 12px; }
      .pnl-import-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
      .pnl-import-status { font-size: 12px; color: #999; margin-top: 6px; }
    `;
    document.head.appendChild(style);
  }

  function createDialog(wide) {
    const dialog = document.createElement('dialog');
    dialog.className = wide ? 'pnl-dialog pnl-dialog-wide' : 'pnl-dialog';
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    return dialog;
  }

  function showEntryDialog(id, existing) {
    injectStyles();
    const dialog = createDialog(false);
    const type = existing ? existing.type : 'friend';
    const note = existing ? existing.note : '';

    dialog.innerHTML = `
      <h3>${existing ? '編輯名單' : '加入名單'}：${id}</h3>
      <div class="pnl-row">
        <label>分類</label>
        <div class="pnl-types">
          <label><input type="radio" name="pnlType" value="friend"> 好友</label>
          <label><input type="radio" name="pnlType" value="block"> 黑名單</label>
          <label><input type="radio" name="pnlType" value="note"> 其他</label>
        </div>
      </div>
      <div class="pnl-row">
        <label>備註</label>
        <input type="text" id="pnlNote" maxlength="60" placeholder="選填">
      </div>
      <div class="pnl-actions">
        ${existing ? '<button class="pnl-btn del" id="pnlDel">刪除</button>' : ''}
        <button class="pnl-btn cancel" id="pnlCancel">取消</button>
        <button class="pnl-btn save" id="pnlSave">儲存</button>
      </div>
    `;

    dialog.querySelector(`input[value="${type}"]`).checked = true;
    dialog.querySelector('#pnlNote').value = note;

    dialog.querySelector('#pnlCancel').addEventListener('click', () => dialog.close());
    dialog.querySelector('#pnlSave').addEventListener('click', () => {
      const chosen = dialog.querySelector('input[name="pnlType"]:checked');
      const t = chosen ? chosen.value : 'friend';
      const n = dialog.querySelector('#pnlNote').value.trim();
      upsertEntry(id, t, n);
      dialog.close();
    });
    const delBtn = dialog.querySelector('#pnlDel');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (confirm(`確定要將「${id}」從名單移除？`)) {
          removeEntry(id);
          dialog.close();
        }
      });
    }

    dialog.showModal();
  }

  function showManagePanel() {
    injectStyles();
    const dialog = createDialog(true);

    function render() {
      const list = loadList();
      const ids = Object.keys(list).sort();
      dialog.innerHTML = `
        <h3>名單管理 (${ids.length})</h3>
        <div class="pnl-toggle-row">
          <label><input type="checkbox" id="pnlAutoLogin" ${getAutoLogin() ? 'checked' : ''}> 自動登入(偵測到瀏覽器已填好帳密就自動送出，不讀取/儲存密碼)</label>
        </div>
        <div class="pnl-cloud">
          <div class="pnl-cloud-title">☁️ 雲端同步 (GitHub Gist)</div>
          <input type="password" id="pnlToken" placeholder="貼上 GitHub Personal Access Token (需 gist 權限)" value="${getToken().replace(/"/g, '&quot;')}">
          <div class="pnl-cloud-actions">
            <button class="pnl-btn save" id="pnlTokenSave">儲存 Token</button>
            <button class="pnl-btn cancel" id="pnlSyncNow">立即同步</button>
          </div>
          <div class="pnl-cloud-status" id="pnlCloudStatus">${getToken() ? (getGistId() ? '已設定，Gist: ' + getGistId() : '已設定 Token，尚未同步過') : '尚未設定，跨裝置需在每台裝置貼上同一組 Token'}</div>
        </div>
        <div class="pnl-import">
          <div class="pnl-import-title">📋 批次匯入 (貼上 TXT 內容，一行一個 ID，也接受逗號/空白分隔)</div>
          <div class="pnl-import-cols">
            <div class="pnl-import-col">
              <label>好友 ID</label>
              <textarea id="pnlImportFriend" placeholder="ID1&#10;ID2&#10;ID3"></textarea>
            </div>
            <div class="pnl-import-col">
              <label>黑名單 ID</label>
              <textarea id="pnlImportBlock" placeholder="ID1&#10;ID2&#10;ID3"></textarea>
            </div>
          </div>
          <div class="pnl-import-actions">
            <button class="pnl-btn save" id="pnlImportBtn">匯入</button>
          </div>
          <div class="pnl-import-status" id="pnlImportStatus"></div>
        </div>
        <div class="pnl-manage-list">
          ${
            ids.length === 0
              ? '<div style="color:#888;font-size:13px;padding:10px 0;">尚無資料，於終端機右鍵點選ID即可加入</div>'
              : ids
                  .map((id) => {
                    const e = list[id];
                    const meta = TYPE_META[e.type] || TYPE_META.note;
                    return `
                  <div class="pnl-manage-item" data-id="${id}">
                    <span class="tag" style="background:${meta.color}">${meta.label}</span>
                    <span class="id">${id}</span>
                    <span class="note">${e.note ? e.note.replace(/</g, '&lt;') : ''}</span>
                    <button class="mini-btn edit-btn">編輯</button>
                    <button class="mini-btn del-btn">刪除</button>
                  </div>
                `;
                  })
                  .join('')
          }
        </div>
        <div class="pnl-actions">
          <button class="pnl-btn cancel" id="pnlManageClose">關閉</button>
        </div>
      `;
      dialog.querySelectorAll('.edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.closest('.pnl-manage-item').dataset.id;
          dialog.close();
          showEntryDialog(id, loadList()[id]);
        });
      });
      dialog.querySelectorAll('.del-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.closest('.pnl-manage-item').dataset.id;
          if (confirm(`確定要將「${id}」從名單移除？`)) {
            removeEntry(id);
            render();
          }
        });
      });
      dialog.querySelector('#pnlManageClose').addEventListener('click', () => dialog.close());
      dialog.querySelector('#pnlImportBtn').addEventListener('click', () => {
        const friendText = dialog.querySelector('#pnlImportFriend').value;
        const blockText = dialog.querySelector('#pnlImportBlock').value;
        const nFriend = bulkImport('friend', friendText);
        const nBlock = bulkImport('block', blockText);
        dialog.querySelector('#pnlImportStatus').textContent = `已匯入 好友 ${nFriend} 筆、黑名單 ${nBlock} 筆`;
        render();
      });
      dialog.querySelector('#pnlAutoLogin').addEventListener('change', (e) => {
        setAutoLogin(e.target.checked);
      });
      dialog.querySelector('#pnlTokenSave').addEventListener('click', () => {
        const t = dialog.querySelector('#pnlToken').value.trim();
        setToken(t);
        if (!t) setGistId('');
        dialog.querySelector('#pnlCloudStatus').textContent = t
          ? '已儲存 Token，點「立即同步」拉取/建立雲端名單'
          : '已清除 Token';
      });
      dialog.querySelector('#pnlSyncNow').addEventListener('click', async () => {
        const statusEl = dialog.querySelector('#pnlCloudStatus');
        if (!getToken()) {
          statusEl.textContent = '請先貼上 Token 並儲存';
          return;
        }
        statusEl.textContent = '同步中...';
        try {
          const merged = await pullFromCloud();
          await pushToCloud(merged);
          statusEl.textContent = '同步完成 ' + new Date().toLocaleTimeString() + '，Gist: ' + getGistId();
          render();
        } catch (e) {
          statusEl.textContent = '同步失敗: ' + e.message;
        }
      });
    }

    render();
    dialog.showModal();

    if (getToken()) {
      pullFromCloud()
        .then(() => render())
        .catch((e) => console.warn('[ptt-term-namelist] 開啟面板自動同步失敗', e));
    }
  }

  function addFab() {
    if (document.getElementById('pttNameListFab')) return;
    injectStyles();
    const fab = document.createElement('div');
    fab.id = 'pttNameListFab';
    fab.textContent = '名單';
    fab.title = '開啟 PTT 名單管理';
    fab.addEventListener('click', showManagePanel);
    document.body.appendChild(fab);
  }

  // ---------- register into term.ptt.cc plugin API ----------
  function registerMenuItems(app) {
    app.pluginManager.registerContextMenuItem({
      id: 'namelist_add',
      order: 120,
      visible: (appI, f) => {
        const ctx = computeClickCtx(f);
        return !!ctx.id && !ctx.entry;
      },
      label: () => (clickCtx.id ? `加入名單「${clickCtx.id}」` : '加入名單'),
      onClick: (appI, { state }) => {
        const id = getIdAtPagePos(state.pageX, state.pageY);
        if (id) showEntryDialog(id, null);
      },
    });

    app.pluginManager.registerContextMenuItem({
      id: 'namelist_edit',
      order: 121,
      visible: (appI, f) => {
        const ctx = computeClickCtx(f);
        return !!ctx.id && !!ctx.entry;
      },
      label: () => {
        if (!clickCtx.id || !clickCtx.entry) return '編輯名單';
        const meta = TYPE_META[clickCtx.entry.type] || TYPE_META.note;
        return `編輯名單「${clickCtx.id}」[${meta.label}]`;
      },
      onClick: (appI, { state }) => {
        const id = getIdAtPagePos(state.pageX, state.pageY);
        const list = loadList();
        if (id && list[id]) showEntryDialog(id, list[id]);
      },
    });

    app.pluginManager.registerContextMenuItem({
      id: 'namelist_remove',
      order: 122,
      visible: (appI, f) => {
        const ctx = computeClickCtx(f);
        return !!ctx.id && !!ctx.entry;
      },
      label: () => (clickCtx.id ? `取消名單「${clickCtx.id}」` : '取消名單'),
      onClick: (appI, { state }) => {
        const id = getIdAtPagePos(state.pageX, state.pageY);
        if (!id) return;
        if (!confirm(`確定要將「${id}」從名單移除？`)) return;
        removeEntry(id);
      },
    });

    app.pluginManager.registerContextMenuItem({
      id: 'namelist_manage',
      order: 123,
      visible: () => true,
      label: () => '開啟名單管理',
      onClick: () => showManagePanel(),
    });
  }

  function waitForApp(cb, timeoutMs) {
    const start = Date.now();
    const timer = setInterval(() => {
      const app = pageWindow.app;
      if (app && app.pluginManager && app.buf && app.view) {
        clearInterval(timer);
        cb(app);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        console.warn('[ptt-term-namelist] 等待 window.app 逾時，功能未載入');
      }
    }, 300);
  }

  setupAutoLogin();

  waitForApp((app) => {
    registerMenuItems(app);
    addFab();
    startHighlightLoop();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('開啟 PTT 名單管理', showManagePanel);
    }
    if (getToken()) {
      pullFromCloud().catch((e) => console.warn('[ptt-term-namelist] 啟動同步失敗', e));
    }
    console.log('[ptt-term-namelist] 已載入，右鍵選單可加入/編輯/取消名單');
  }, 30000);
})();
