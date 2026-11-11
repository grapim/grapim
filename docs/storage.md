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

## hub 的預設儲存也可以是 Google Cloud Storage 或 Azure

`HUB_STORAGE_URL` 除了 `file://` 和 `s3://`，也接受：

```
HUB_STORAGE_URL=gs://<bucket>/grapim
GRAPIM_GCS_ACCESS_KEY_ID=<HMAC key 的 Access ID>
GRAPIM_GCS_SECRET_ACCESS_KEY=<HMAC key 的 Secret>

HUB_STORAGE_URL=azure://<storage account>/<container>/grapim
GRAPIM_AZURE_ACCOUNT_KEY=<storage account 的 access key>
```

- GCS 走它和 S3 相容的 XML API（`https://storage.googleapis.com`，path-style 網址，AWS SigV4，region 用 `auto`）。依 Google 的文件，它處理有對應 `x-goog-*` 的 `x-amz-*` header（`x-amz-date`、`x-amz-content-sha256` 都有），不送 `x-amz-security-token`（HMAC key 沒有 session token）。列出物件用 ListObjectsV2；萬一 GCS 回的是 V1 格式（沒有 `NextContinuationToken`），就改用 `marker=` 往下翻頁。刪除不存在的物件時 GCS 回 404，S3 回 204，兩者都當成功。
- Azure 用 Blob REST API 和 Shared Key 簽章（node:crypto 自己算，不靠套件）。
- 憑證一樣只從環境變數讀，不會出現在 log 或錯誤訊息裡。HMAC key 和 account key 怎麼建，見下面「客戶自己的 bucket」各家的步驟，做法相同。

## 客戶自己的 bucket（每個 team 各自設定，只有 owner 能改）

一個 team 可以把自己 workspace 的檔案和所有版本放在自己的 bucket，而不是 hub 的儲存。支援 Amazon S3、Cloudflare R2、Google Cloud Storage 和 Azure Blob Storage。

### 規則

**誰能設定**

- 只有 team 的 owner。設定入口是 team **Settings** 頁的 **Storage** 卡片。member 看不到這張卡片，送出也會得到 403；其他 team 的人一律得到 404，和 team 不存在時一樣。
- 平台（platform）也可以用 API 設定：`PUT /v1/settings`，帶 `storage` 欄位，欄位和卡片相同。只有 live key 可以設；test key 會得到 403 `livemode_required`，而且整個請求都不會生效。`storage: null`（或 `provider: "hub"`）代表搬回 hub 的儲存。

**存什麼、怎麼存**

- 設定內容：provider（`s3`、`r2`、`gcs`、`azure`）、bucket（Azure 是 container）、prefix、endpoint、region（只有 S3）、storage account（只有 Azure），以及憑證。
- 憑證用 AES-256-GCM 加密後存放。金鑰由 `HUB_SECRET` 推導，密文同時綁定欄位名稱和 team id：把 A team 的密文複製到 B team，或複製到另一個欄位，都解不開。
- 憑證存檔後就不會再顯示：頁面、API 回應、log 和錯誤訊息裡都不會出現。要換的話重新輸入一組即可。如果新設定和目前是同一個 bucket、只換 key，就只替換 key，不會搬資料。
- 如果 `HUB_SECRET` 換了，舊的密文就解不開了。卡片會顯示「They cannot be read any more」，請 owner 重新輸入憑證。在重新輸入之前，這個 team 的寫入會失敗，而不是悄悄改寫到 hub 的儲存。

**存檔前先測試**

- endpoint 的檢查規則和 webhook 一樣：只接受 https；不能帶帳號密碼、路徑或 query；DNS 解析出來的每個位址都必須是公開位址，不能是 private、loopback、link-local（包括雲端 metadata 的 169.254.169.254）或其他保留位址；不跟隨 redirect。之後每一次連線都會重新檢查，結果最多快取一分鐘，而且連線會直接連到檢查過的那個位址，所以就算之後 DNS 被改指向內網也連不過去。
- 接著做一次連線測試：在 `<prefix>/grapim-probe/` 下面寫入一個隨機 key，讀回來比對內容，列出，刪除，再確認它真的不見了。任何一步失敗，就會顯示是哪一步失敗、HTTP 狀態碼和錯誤代碼，而且什麼都不會存。測試用的 key 不論成功或失敗都會刪掉；只有在 key 沒有刪除權限的情況下會留下來，錯誤訊息也會直接說明這一點。

**搬移**

- 存檔後，背景工作會把這個 team 在目前儲存裡的所有 blob 和 manifest（`ws/<team_id>/...`）複製到新的 bucket。卡片上會顯示進度；重新整理頁面就能看到最新的數字。
- 可以中斷後接續：每複製一個 key 就記下進度。hub 重啟後，會從上次停下的地方繼續。
- 冪等：新 bucket 裡已經有的 blob 不會再傳一次（blob 以 sha1 命名，內容不會變）；manifest 只有內容不同時才覆寫。來回搬好幾次，每個物件也只會被複製一次。
- 搬移期間：
  - 寫入會同時寫到兩邊。先寫舊的儲存，舊的仍然是權威來源。如果新 bucket 寫入失敗，請求本身不會失敗，那個 key 會在切換前再複製一次。
  - 讀 blob 時先讀新 bucket，找不到再讀舊的。
  - 讀 manifest（唯一會改變的物件）時一律讀舊的儲存，因為每次寫入都會先寫到那裡。這樣即使新 bucket 裡有以前留下的舊 manifest，也不會被誤讀。
- 什麼時候切換：複製完一輪之後，會再完整檢查一輪；要等某一輪完全不需要再複製、沒有寫入正在進行、也沒有寫到新 bucket 失敗的 key，才會切換過去。如果檔案一直在變，跑了 6 輪還停不下來，搬移會標示為失敗，可以稍後再按 Retry。
- 失敗時，卡片會顯示原因，並提供 **Retry**（從上次的進度繼續）和 **Cancel move** 兩個按鈕。取消後會維持原本的儲存；已經複製過去的物件會留在新 bucket。搬移進行中不能再改設定（API 會回 409 `storage_moving`）。
- 搬回 hub 的儲存（卡片上的 **Move back to the hub's storage**，或 API 的 `storage: null`）用同一套流程。
- 舊儲存裡的資料不會自動刪除。搬到自己的 bucket 之後，hub 磁碟上那份要等之後的清除功能（v1）；搬回 hub 之後，你 bucket 裡那份由你自己決定是否刪除。

### 客戶端要做的事（最小權限）

每一家都建議**為 Grapim 開一個專用的 bucket**（Azure 則是一個專用的 storage account），並且只給下面列出的權限。Grapim 需要做的事只有：寫入、讀取、刪除物件，以及列出 prefix 底下的物件。它不會建立或刪除 bucket，也不會改 bucket 的設定。

bucket 保持 private 即可：不需要 public access、CORS 或 custom domain。

#### Amazon S3

1. 在 S3 建立 bucket（例如 `acme-grapim`），記下 region（例如 `eu-west-1`）。保持 **Block all public access** 開啟。預設的加密（SSE-S3）就可以了；如果用 SSE-KMS，下面的 user 也需要那把 KMS key 的 `kms:Encrypt`、`kms:Decrypt` 和 `kms:GenerateDataKey` 權限。
2. 在 IAM 建一個專用的 user（例如 `grapim-storage`），不給 console 權限，只附加下面這份 inline policy。`acme-grapim` 換成你的 bucket 名稱，`grapim` 換成你要填的 prefix：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GrapimObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::acme-grapim/grapim/*"
    },
    {
      "Sid": "GrapimList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-grapim",
      "Condition": { "StringLike": { "s3:prefix": ["grapim/*"] } }
    }
  ]
}
```

   HEAD（檢查物件在不在）由 `s3:GetObject` 涵蓋。如果沒有填 prefix，把 `grapim/*` 改成 `*`。
3. 替這個 user 建一組 access key（**Security credentials → Create access key**，用途選 *Application running outside AWS*）。
4. 在 Grapim 的卡片上：Provider 選 **Amazon S3**，填入 bucket、prefix、region 和這組 key。endpoint 可以不填，預設是 `https://s3.<region>.amazonaws.com`。

#### Cloudflare R2

1. 建立 bucket（步驟和本文第 1 節相同）。
2. **Manage R2 API Tokens → Create API token**：權限選 **Object Read & Write**，**Apply to specific buckets only** 只勾這個 bucket。R2 的 token 無法限制到 prefix，所以更需要用專用的 bucket。
3. 在卡片上：Provider 選 **Cloudflare R2**，endpoint 填 `https://<account_id>.r2.cloudflarestorage.com`（歐盟管轄區是 `https://<account_id>.eu.r2.cloudflarestorage.com`），再填入 Access Key ID 和 Secret Access Key。region 固定是 `auto`，不用填。

#### Google Cloud Storage

1. 建立 bucket，**Access control** 選 **Uniform**，**Prevent public access** 保持開啟。
2. 建一個專用的 service account（例如 `grapim-storage@<project>.iam.gserviceaccount.com`），不要給它任何專案層級的角色。
3. 建一個 custom role，只包含這 4 個權限：`storage.objects.create`、`storage.objects.get`、`storage.objects.delete`、`storage.objects.list`。然後在**這個 bucket 的 Permissions** 裡，把這個 role 授予上面的 service account。GCS 覆寫既有物件時需要 delete 權限，而 manifest 會被覆寫，所以這 4 個權限缺一不可。
   - 也可以直接授予 bucket 層級的 `roles/storage.objectUser`，它比較寬，但還在可接受的範圍。
   - 如果一定要限制到 prefix，可以在 create、get、delete 加上 IAM Condition：`resource.name.startsWith("projects/_/buckets/<bucket>/objects/<prefix>/")`。不過 list 是 bucket 層級的權限，無法用這種條件限制，所以還是建議用專用的 bucket。
4. **Cloud Storage → Settings → Interoperability**：在 **Service account HMAC** 底下，替這個 service account **Create a key**，記下 Access ID 和 Secret。如果組織政策 `constraints/storage.restrictAuthTypes` 擋掉了 HMAC，就需要先請管理員放行。
5. 在卡片上：Provider 選 **Google Cloud Storage**，填入 bucket、prefix，以及 HMAC 的 Access ID（填在 Access key ID）和 Secret（填在 Secret access key）。endpoint 可以不填，預設是 `https://storage.googleapis.com`。

#### Azure Blob Storage

1. 建一個**專用的** storage account（例如 `acmegrapim`），Performance 選 Standard，**Allow Blob anonymous access** 關閉，**Allow storage account key access** 開啟（Shared Key 要用到）。
2. 在裡面建一個 container（例如 `grapim`），**Public access level** 選 **Private**。
3. **Security + networking → Access keys**：複製 key1 的 **Key**。
4. 在卡片上：Provider 選 **Azure Blob Storage**，填入 storage account、container（填在 Bucket or container）、prefix，以及 account key。endpoint 可以不填，預設是 `https://<account>.blob.core.windows.net`。

Azure 的 account key 不能限制到單一 container 或特定動作，它等於整個 storage account 的完整權限。這是 Shared Key 本身的限制，所以務必讓這個 storage account 只放 Grapim 的資料。目前還不支援用 SAS 或 Entra ID 來縮小權限範圍。

### 換 key 或撤銷

1. 在你的雲端建立一組新的 key（權限和上面相同）。
2. 回到卡片，展開 **Replace the keys, or move to another bucket**，用同樣的 bucket、prefix、endpoint 填入新的 key，按 **Test and save**。測試通過後，就只會替換 key，不會搬資料。
3. 確認卡片上的 Credentials saved 日期更新了，再到雲端停用或刪除舊的 key。

如果你直接在雲端撤銷 key，而沒有先在 Grapim 換掉，這個 team 的寫入會開始失敗（hub 的 log 會記下 HTTP 403，但不會記下 key），直到 owner 填入新的 key 為止。
