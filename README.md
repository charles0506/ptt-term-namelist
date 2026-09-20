# ptt-term-namelist

Tampermonkey userscript：在官方網頁版 PTT 終端機 [term.ptt.cc](https://term.ptt.cc) 的右鍵選單加入「名單」功能，可以標記好友／黑名單／其他備註，資料存在本機瀏覽器（Tampermonkey storage），不會經過任何第三方伺服器。

靈感來自 PTTStar 等傳統 PTT client 常見的「加入名單／編輯名單／取消名單」功能。

## 功能

- 在文章列表、推文、看板等任何顯示 ID 的地方，右鍵點該 ID：
  - **加入名單**：選擇分類（好友／黑名單／其他）+ 備註
  - **編輯名單**：已加入的 ID 會改顯示編輯選項，並標示目前分類
  - **取消名單**：從名單移除（會二次確認）
- 右下角浮動「名單」按鈕：開啟總管理面板，列出所有已標記的 ID，可直接編輯／刪除

## 安裝

1. 瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/) 擴充套件
2. 開啟 Tampermonkey 後台 → 新增指令碼 (Create a new script)
3. 貼上 [`ptt-term-namelist.user.js`](./ptt-term-namelist.user.js) 的內容，儲存
4. 開啟 https://term.ptt.cc ，右鍵任一 ID 即可使用

## 原理

term.ptt.cc 本身是官方開源終端機模擬器（`ptt-term`），內建 plugin 系統（`window.app.pluginManager`），支援外部程式註冊右鍵選單項目（`registerContextMenuItem`）。本 script 利用：

- `app.view.clientToPos(clientX, clientY)` 把滑鼠座標轉成終端機的 row/col
- `app.buf.lines[row]`（含 DBCS 全形字判斷）組出該行純文字，再用正規表示式抓出游標位置對應的 ID
- `app.pluginManager.registerContextMenuItem(...)` 掛上「加入/編輯/取消名單」選單項目
- `GM_getValue` / `GM_setValue` 做本機持久化儲存

不會修改、注入到 term.ptt.cc 官方站台本身，純粹是瀏覽器端疊加的 userscript。

## 限制

- 目前僅提供選單操作與管理面板，**不會**在畫面上即時把已標記的 ID 變色/加註記（例如推文列表自動標紅黑名單），這需要額外 hook 畫面渲染，之後有需求可以再擴充。
- 名單資料存在瀏覽器本機（Tampermonkey storage），換瀏覽器/清除資料不會保留，也不會跨裝置同步。

## License

MIT
