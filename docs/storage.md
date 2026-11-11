# 把 hub 的儲存接到 Cloudflare R2

hub 會把每個雲端 workspace 的檔案版本存進一個「儲存後端」。預設是 hub 自己的磁碟（`file://${HUB_DATA}/storage`）；換成 R2 之後，就算 hub 的 volume 不見了，workspace 也能從 R2 還原。

存進去的格式（在 bucket 裡，前面會加上網址裡的前綴，例如 `grapim/`）：

```
grapim/ws/<team_id>/<workspace_id>/blobs/<sha1>      檔案內容，用 sha1 命名，同樣內容只存一份
grapim/ws/<team_id>/<workspace_id>/manifest.json     路徑 → sha1 的清單，加上 git HEAD
```

整個流程大約 10 分鐘，下面照順序做。

## 1. 建立 bucket

1. 登入 Cloudflare dashboard，左側選 **R2 Object Storage**。第一次用的話要先啟用 R2（需要綁付款方式，但免費額度內不收費）。
2. 按 **Create bucket**。
   - Bucket name：例如 `grapim-workspaces`（只能用小寫英文、數字和 `-`）。
   - Location：選 **Automatic** 就好。如果客戶要求資料留在歐盟，選 **Specify jurisdiction → EU**（這時 endpoint 會不一樣，見第 3 步）。
   - Storage class：**Standard**。
3. 按 **Create bucket**。
4. 回到 R2 總覽頁，右側有 **Account ID**，先記下來，第 3 步會用到。

bucket 保持 private 就好：不需要開 public access、不需要 custom domain、也不需要設 CORS，因為只有 hub 的伺服器會存取它。

## 2. 建立只能讀寫這個 bucket 的 API token

1. 在 R2 總覽頁按 **Manage R2 API Tokens**（或 **API → Manage API tokens**），再按 **Create API token**。
2. 設定如下：
   - Token name：例如 `grapim-hub`。
   - Permissions：選 **Object Read & Write**。不要選 Admin，hub 不需要建立或刪除 bucket。
   - Specify bucket(s)：選 **Apply to specific buckets only**，只勾第 1 步建的 `grapim-workspaces`。
   - TTL：可以選 Forever，或設一個到期日並記得換。
   - Client IP Address Filtering：如果 hub 有固定的對外 IP，可以填進去；沒有就留空。
3. 按 **Create API Token**。畫面會顯示：
   - **Access Key ID**
   - **Secret Access Key**（只會顯示這一次）
   - S3 endpoint：`https://<account_id>.r2.cloudflarestorage.com`

先不要關掉這個頁面，下一步要用。這兩個 key 不要貼到聊天、issue、程式碼或 commit 裡。

## 3. 設定 hub 的環境變數

到 hub 的部署平台（例如 Railway 服務的 **Variables** 頁）新增三個變數。

```
HUB_STORAGE_URL=s3://<bucket>/grapim?endpoint=https://<account>.r2.cloudflarestorage.com&region=auto
GRAPIM_S3_ACCESS_KEY_ID=<第 2 步的 Access Key ID>
GRAPIM_S3_SECRET_ACCESS_KEY=<第 2 步的 Secret Access Key>
```

- `<bucket>` 換成 bucket 名稱，`<account>` 換成第 1 步記下的 Account ID。例如：
  `s3://grapim-workspaces/grapim?endpoint=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com&region=auto`
- 網址路徑裡的 `grapim` 是 bucket 內的前綴。所有東西都會放在 `grapim/` 底下，所以同一個 bucket 之後要放別的東西也不會混在一起。
- `region=auto` 是 R2 的固定寫法。
- 如果 bucket 建在歐盟管轄區，endpoint 要改成 `https://<account>.eu.r2.cloudflarestorage.com`。
- 兩個 key 由創辦人自己貼進平台的變數欄位，不經過任何人或工具轉手。程式只從環境變數讀取它們，不會寫進 log 或錯誤訊息。錯誤訊息只會有操作名稱、key、HTTP 狀態碼和 S3 錯誤代碼，不會有 key、簽章或 string to sign。
- 在 shell 裡手動 export 時，整串網址要用單引號包起來，因為裡面有 `&`。

存檔後，平台會重新部署 hub。

改成 R2 之後，舊的 `file://` 儲存不會自動搬過去。hub 下次替每個 workspace 寫 manifest 時，會把目前所有檔案的 blob 補傳到 R2（已經存在的 blob 不會重傳）。

## 4. 確認接上了

### 方法一：在 hub 的 shell 跑一次讀寫測試

在 hub 的容器裡（例如 Railway 的 shell，或用同樣的環境變數在本機跑），於 repo 根目錄執行：

```sh
node --input-type=module -e "
import { createStorage } from './src/storage/index.js';
const s = createStorage(process.env.HUB_STORAGE_URL);
const k = 'healthcheck/' + Date.now();
await s.put(k, Buffer.from('ok'));
console.log('讀回:', (await s.get(k)).toString());
console.log('列出:', await s.list('healthcheck/'));
await s.delete(k);
console.log('刪除後還在嗎:', await s.has(k));
console.log('OK', s.describe());
"
```

成功的話會看到 `讀回: ok`、列出剛剛那個 key、`刪除後還在嗎: false`，最後一行是 `OK s3://<bucket>/grapim/ via https://<account>.r2.cloudflarestorage.com (auto)`。`describe()` 不會印出任何 key。

### 方法二：看 R2 dashboard

在 hub 上建一個 workspace，寫入一個檔案，等大約 30 秒（manifest 最多每 30 秒寫一次）。接著到 R2 → bucket → **Objects**，應該會看到 `grapim/ws/<team_id>/<workspace_id>/blobs/...` 和 `manifest.json`。

### 常見錯誤

| 看到的錯誤 | 通常的原因 |
| --- | --- |
| `S3 storage needs GRAPIM_S3_ACCESS_KEY_ID and GRAPIM_S3_SECRET_ACCESS_KEY` | 變數名稱打錯，或還沒重新部署 |
| `HTTP 403 SignatureDoesNotMatch` | Secret Access Key 貼錯或多了空白；或 endpoint 的 Account ID 錯了 |
| `HTTP 403 AccessDenied` | token 沒有勾到這個 bucket，或權限只有 Read |
| `HTTP 404 NoSuchBucket` | 網址裡的 bucket 名稱和實際名稱不一樣，或 bucket 在 EU 管轄區但 endpoint 沒加 `.eu` |
| `timed out` / `network error` | hub 連不到 R2；如果 token 設了 IP 過濾，檢查 hub 的對外 IP |

遇到 5xx 或 429，程式會自動退避重試；遇到 4xx 則不重試，直接回報，因為那是設定問題，重試也不會好。

## 換 key 或撤銷

1. 在 R2 的 API token 頁面建一個新的 token（權限一樣）。
2. 在部署平台更新 `GRAPIM_S3_ACCESS_KEY_ID` 和 `GRAPIM_S3_SECRET_ACCESS_KEY`，重新部署。
3. 跑一次第 4 步的檢查。
4. 確認沒問題後，回 R2 刪除舊 token。

## 之後：客戶自己的 bucket

docs/workspaces.md 預留了 `teams.storage_url`：之後一個 team 可以指向客戶自己的 bucket，只有 owner 能設定。這個 bucket 的憑證怎麼存放還沒做（留到 v1），目前所有 team 都用 `HUB_STORAGE_URL`。
