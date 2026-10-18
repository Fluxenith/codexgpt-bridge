# CodexGPT Bridge

**在 Codex 使用你 ChatGPT 帳號可用的網頁模型。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**[下載 Windows、macOS 或 Linux 安裝檔](https://github.com/Fluxenith/codexgpt-bridge/releases/latest)** ·
**[快速開始](#開始使用)** ·
**[回報試用結果](https://github.com/Fluxenith/codexgpt-bridge/issues/new?template=early_tester_feedback.md)**

CodexGPT Bridge 連接 Codex 與你已登入的 ChatGPT 網頁。你可以在 Codex
選擇帳號可用的網頁模型，並由 Codex 管理專案檔案、工具與核准。
Bridge 支援每個任務獨立對話、圖片、進度顯示與取消。

本專案為獨立第三方專案，與 OpenAI 沒有隸屬關係。

**v0.1.103：** Full MCP 的官方 Tunnel 程式可自動下載並驗證，路徑留白即可。Tunnel ID、Runtime API key 與外掛權限仍需設定。

## 觀看實際示範

![CodexGPT Bridge：實際修正程式並通過測試](assets/launch/demo-preview-en.gif)

展示紀錄與介面錄於 v0.1.102；下方自動安裝流程適用於 v0.1.103。

46 秒英文示範 · [觀看完整畫質 MP4](assets/launch/demo-en.mp4)

使用 Bridge 的 Medium 模型與 Full MCP，讓 Codex CLI 修正一個計算錯誤。
相同測試由 **1 通過、2 失敗**變成 **3 通過、0 失敗**，測試斷言保持不變。
影片為真實工具事件與輸出的剪輯重播，搭配實際英文 Bridge 介面截圖；
本片未展示首次安裝流程。作者：[Fluxenith](https://github.com/Fluxenith)。

## 選擇連線模式

|          | Simple                  | Full MCP                                        |
| -------- | ----------------------- | ----------------------------------------------- |
| 適合     | 快速試用模型回覆        | 需要模型透過連接器呼叫 Codex 工具               |
| 工具運作 | 以文字傳遞工具指令      | 使用 ChatGPT 自訂外掛與 Secure MCP Tunnel       |
| 額外設定 | 不需要自訂外掛或 Tunnel | 需要外掛權限、Tunnel 權限與相容的 tunnel-client |

建議初次先用 **Simple** 測試。如果帳號與工作區具備權限，
且需要真正的工具呼叫，再設定 **Full MCP**。
詳細步驟請看 **[ChatGPT 外掛設定](#chatgpt-外掛設定)**。

## 安裝

從本倉庫的 **[Releases](https://github.com/Fluxenith/codexgpt-bridge/releases/latest)** 頁面下載適合你作業系統的安裝檔。
Windows 使用 `CodexGPT-Bridge-Setup-<版本>.exe`；macOS 使用 DMG；
Linux 使用 AppImage 或 DEB。

**macOS 測試版：** Intel 與 Apple Silicon 安裝檔尚未經 Apple 公證。首次嘗試
開啟後，可能需要到「系統設定 → 隱私權與安全性 → 仍要打開」允許執行。
請確認來源可信再允許，詳見 [Apple 官方說明](https://support.apple.com/zh-tw/102445)。

你需要已安裝的 Codex，以及可使用所需模型的 ChatGPT 帳號。
可用模型與使用額度依帳號而定。
Bridge 依賴 ChatGPT 網頁介面，介面變動可能影響運作。使用前請確認
相關服務條款與帳號條件；Bridge 不保證連線不中斷，也不會解除使用額度限制。

## 開始使用

1. 開啟 Bridge，選擇瀏覽器與工具連線。初次使用可選 Simple；
   Full MCP 請依照下方的外掛與 Tunnel 教學完成設定。
2. 點選「開啟 ChatGPT 登入」並登入。Chrome 登入完成後，
   回到 Bridge 確認「登入完成，繼續」。
3. 點選「測試 ChatGPT 連線」，再「安裝 Web 模型」。
4. 重新啟動 Codex，選擇 `CodexGPT Bridge — …` 模型。

使用這些模型時請保持 Bridge 執行。關閉主視窗後程式會留在系統匣；
「結束」會停止程式。「移除 Web 模型」會還原先前由 Bridge 管理的設定。

介面支援英文、繁體中文、簡體中文、日文與韓文，可從「語言」選單切換。

可用模型與實際上下文上限依 Bridge 版本及帳號而定。上方 Demo 驗證的是
小型程式修改任務，並未測量最大上下文長度。

## ChatGPT 外掛設定

這裡的 GPT 外掛是 ChatGPT 的自訂 MCP 外掛（部分介面稱為 App 或連接器）。
Full MCP 透過這個外掛，讓 ChatGPT 呼叫目前 Codex 任務提供的工具；
Simple 則以文字傳遞工具指令，初次使用不需要建立外掛或 Tunnel。

設定順序：**取得 Tunnel → 填入 Bridge → 啟動 Web 模型服務 → 建立並安裝 ChatGPT 外掛 → 在 Codex 驗證**。

### 1. 確認帳號與權限

使用 ChatGPT 網頁版，確認目標帳號／工作區允許新增及使用自訂 MCP 外掛，
並可存取 [OpenAI Platform 的 Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)。
ChatGPT 工作區權限與 Platform 組織的 Tunnel 權限是分開管理的：

| 操作                                      | 所需權限                                   |
| ----------------------------------------- | ------------------------------------------ |
| 檢視 Tunnel                               | Platform 組織的 Tunnels **Read**           |
| 建立或修改 Tunnel                         | Tunnels **Read + Manage**                  |
| 執行 tunnel-client、在外掛設定選取 Tunnel | Tunnels **Read + Use**                     |
| 新增、安裝及使用 ChatGPT 外掛             | 目標 ChatGPT 帳號／工作區允許自訂 MCP 外掛 |

若沒有權限，請由組織／工作區管理員開放；若目前無法使用，先選 **Simple**。
僅有 ChatGPT Pro 訂閱不代表已取得 Tunnel 或工作區權限。
實際可用性及入口請以你的帳號和 [OpenAI 官方自訂 MCP 文件](https://developers.openai.com/api/docs/guides/custom-mcp-server) 為準。

### 2. 取得 Tunnel、Runtime API key 與官方 client

1. 開啟 [Platform Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)，
   選擇要使用的 Platform 組織，建立或選取 Tunnel。
2. 確認 Tunnel 關聯到要使用的 **ChatGPT 工作區**，以及管理這個 Tunnel 的 Platform 組織。
   個人帳號使用該帳號的個人 Platform 組織；只關聯 Platform 組織，不會自動讓另一個工作區看見 Tunnel。
3. 複製 Tunnel ID。格式為 `tunnel_` 加上 32 個小寫十六進位字元。
4. 請 Platform 組織管理員提供供 `tunnel-client` 使用的 **Runtime API key**，
   確認對所選組織／Tunnel 有 **Read + Use** 權限。這個 key 稍後填入 Bridge，請勿放進 README、Issue 或截圖。
5. **tunnel-client 路徑留白即可。** 首次使用 Full MCP 時，Bridge 會依作業系統與 CPU 架構，
   自動下載固定版本的官方程式、驗證 SHA-256 校驗碼，並安裝必要的伴隨檔案。
   首次設定需要網路，之後會驗證並重用本機安裝；不必自行下載、解壓縮或指定路徑。

Bridge 會管理 client 的啟動與本機 MCP 位址；依照這份教學設定時，不需要另外啟動一個指向相同 Tunnel 的 client。
進階使用者仍可填入自行安裝的可執行檔絕對路徑；該版本需支援 `tunnel-client runtimes connect --help`。
詳細權限、組織關聯與網路需求見 [官方 Secure MCP Tunnel 教學](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 3. 填入 Bridge，讓 Tunnel 就緒

1. 開啟 Bridge，完成「開啟 ChatGPT 登入」與「測試 ChatGPT 連線」。
   登入的帳號與選取的工作區，必須是稍後安裝外掛的帳號／工作區。
2. 在「Codex 工具連線」選擇 **Full MCP — 連接器呼叫工具**，展開「進階 Tunnel 設定」。
3. 填入以下欄位：

   | Bridge 欄位            | 要填什麼                                                           |
   | ---------------------- | ------------------------------------------------------------------ |
   | ChatGPT connector 名稱 | 建議 `CodexGPT Bridge`；必須與稍後建立的外掛名稱完全一致，包括空格 |
   | OpenAI Tunnel ID       | 第 2 步取得的完整 Tunnel ID                                        |
   | OpenAI API key         | 供 tunnel-client 使用的 Runtime API key；已儲存時，不需每次重貼    |
   | tunnel-client 路徑     | 留白自動下載與驗證；只有覆寫為自行安裝版本時才填絕對路徑           |

4. 按 **「套用」**，再按 **「安裝 Web 模型」** 啟動服務。已安裝模型且服務正在執行時，套用會重新啟動連線。
5. 保持 Bridge 執行，確認出現 **「Tunnel：已就緒」**，再到 ChatGPT 建立外掛。

**第一次只按「套用」，不會啟動尚未安裝的 Web 模型服務。**
因此即使 ID 與 key 都已填好，仍可能顯示「Tunnel：尚未就緒」。
先完成「安裝 Web 模型」；若安裝失敗，依畫面錯誤與下方排查表處理。

### 4. 在 ChatGPT 新增並安裝外掛

以下依 [官方新增自訂 MCP server 流程](https://developers.openai.com/api/docs/guides/custom-mcp-server)：

1. 在同一帳號／工作區，到 **Settings → Security and login** 開啟 **Developer mode**，
   再開啟 **[ChatGPT Plugins](https://chatgpt.com/plugins)**。
   此入口依 [OpenAI 官方 Tunnel 連線範例](https://developers.openai.com/cookbook/examples/partners/aws/chatgpt_agents_sdk_aws_agentcore_cookbook/notebooks/chatgpt_agents_sdk_aws_agentcore_cookbook#7-test-the-plugin-connection-in-chatgpt-through-secure-mcp-tunnel)；若沒有開關，請確認工作區政策與帳號可用性。
2. 點選 **「＋」→ Add custom MCP server**。
3. 名稱填入 `CodexGPT Bridge`，或你在 Bridge「ChatGPT connector 名稱」設定的名稱。
4. **Connection 選擇 Tunnel**，選取你的 Tunnel，或貼上相同的 Tunnel ID。
   此連線方式使用 Tunnel ID，無須把本機 `127.0.0.1` 位址貼到 Server URL。
5. Bridge 內建 MCP server 沒有 OAuth 登入流程，驗證方式選擇 **No authentication**。
   Runtime API key 留在 Bridge 的 Tunnel 設定，不填到 ChatGPT 的 OAuth Client Secret。
6. 閱讀權限提示，勾選 **I understand and want to continue**，按 **Create as a plugin**。
7. 在個人外掛或剛才的工作區找到新建外掛，**安裝／啟用**，確認所需工具未被停用。
   建立成功後仍需安裝，才能在對話使用。

若帳號仍使用舊版「Apps／連接器」介面，依該頁顯示的 Developer Mode、建立自訂 App 與啟用流程操作，
同樣使用一致的名稱和 Tunnel ID。若看不到建立入口，先確認帳號／工作區權限。

### 5. 在 Codex 驗證工具呼叫

1. 重新啟動 Codex，選擇 **`CodexGPT Bridge — …`** 模型，保持 Bridge 與 Tunnel 執行。
2. 在一個測試專案開啟新任務，例如要求：「列出目前專案根目錄的檔案名稱，不修改任何檔案。」
3. 確認 Codex 出現實際工具呼叫並收到結果。只有 ChatGPT 文字說「已連線」不能證明工具可用。
4. 若要單獨檢查 ChatGPT 是否已安裝外掛，可在 ChatGPT 的輸入框輸入 `@`，確認可選到同名外掛。
   Bridge 工具需要有效的 Codex 任務上下文，直接在一般聊天呼叫可能回報沒有作用中的任務。

第一次驗證先使用一般聊天與自動送出。需要手動送出時，先套用 Full MCP，再切換互動方式；
使用暫時聊天時，該模式也必須允許 Apps，否則 Bridge 會停止送出。

### 常見設定問題

| 現象                                   | 檢查與處理                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tunnel 尚未就緒，只有按過「套用」      | 按「安裝 Web 模型」啟動服務；保持 Bridge 執行                                                                |
| 安裝模型時回報 client 路徑或子命令錯誤 | 清空 client 路徑以使用自動安裝；若自行指定，確認絕對路徑、系統／架構與 `runtimes connect` 功能相容           |
| 自動下載失敗或校驗碼不符               | 確認可連線至 GitHub 官方下載後重試；驗證失敗不會執行下載內容，也可在進階設定指定自行安裝的官方程式           |
| key 或 Tunnel 驗證失敗                 | 確認 key 未失效、ID 完整、所屬組織正確，並具 Tunnels Read + Use；填入新 key 後重新套用                       |
| Platform 顯示 Tunnels access required  | 請 Platform 組織管理員授予組織層級的 Tunnel 權限；新角色可能需要最多 30 分鐘生效                             |
| ChatGPT 找不到 Tunnel                  | 確認 Tunnel 關聯到目前 ChatGPT 工作區，且建立外掛的使用者有 Read + Use                                       |
| 建立外掛時無法取得工具                 | 先讓 Bridge 顯示 Tunnel 已就緒，再重新建立或重新整理外掛工具                                                 |
| Tunnel 已就緒，但 Full MCP 工具不可用  | 確認外掛已安裝／啟用、工具未停用、名稱完全一致，且 Bridge 登入相同帳號／工作區；以新的 Codex 任務再測一次    |
| 重啟後連線中斷                         | 保持 Bridge 執行，確認 Web 模型仍已安裝；執行「Doctor」並檢查錯誤。網路需允許 client 對 OpenAI 的 HTTPS 連線 |
| 帳號沒有自訂 MCP／Tunnel 功能          | 先使用 Simple；依官方文件和管理員設定確認可用性                                                              |

## 更新與問題排查

GitHub 發布流程會將此倉庫的更新網址內建至安裝包，使用者不需手動設定。
Bridge 會在啟動與背景執行期間
檢查新版；線上更新需要可存取的更新清單與安裝檔。更新來源尚未可用時，
請從 **[Releases](https://github.com/Fluxenith/codexgpt-bridge/releases/latest)** 下載新版。

連線失敗時，先確認 ChatGPT 登入狀態，再執行 Bridge 的「Doctor」。
回報問題時請附上程式版本、作業系統與重現步驟，並移除帳號資料、
私人路徑、對話內容與憑證。

登入資料與設定儲存在應用程式的本機使用者設定檔。

## 協助測試 Bridge

Bridge 還在早期階段。如果你願意試用，歡迎
**[提供測試回饋](https://github.com/Fluxenith/codexgpt-bridge/issues/new?template=early_tester_feedback.md)**：
請註明作業系統、連線模式、能否完成設定，以及是否成功在 Codex
執行一個小任務。請勿附上憑證、Cookie、私人程式碼、個人對話及帳號識別資訊。

## 從原始碼啟動

使用 Node.js 22.20.0 以上與 pnpm 11.19.0：

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## 第三方授權

依賴套件的授權保留在 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
及 `LICENSES/`。本專案採用 [MIT 授權條款](LICENSE)。
