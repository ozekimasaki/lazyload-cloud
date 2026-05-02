# lazyload-cloud

Cloudflare 向けのコードコンテキスト CLI です。Agent Skills と組み合わせて使うことを前提に、ローカルの JavaScript / TypeScript / Python プロジェクトを index 化し、必要なコード情報だけを素早く引けるようにします。

この CLI は次の 3 つの使い方に対応しています。

1. **ローカル専用**: index をローカルに保存して使う
2. **Cloudflare Worker 経由**: Worker API に sync / query する
3. **D1 / R2 直結**: Worker を deploy せず、CLI から D1 / R2 を直接使う

## 主な機能

- JS / TS / Python の index 作成
- symbols / functions / classes / references / related context / call trace / type trace の取得
- `watch`, `stats`, `init --yes` 対応
- **13 個の互換コマンド**を CLI から利用可能
- Agent Skills 用の scaffold 生成
- Cloudflare Worker 経由の remote 利用
- **Worker なしの direct D1 / R2 利用**

## インストール

```bash
npm install -g lazyload-cloud
```

現行 version を固定して入れる場合:

```bash
npm install -g lazyload-cloud@0.1.4
```

## クイックスタート

```bash
lazyload-cloud init
lazyload-cloud index
lazyload-cloud stats --format compact
lazyload-cloud query symbols handler --format compact
lazyload-cloud overview --format compact
```

## コマンド概要

- `init` - `lazyload.config.json`、skills、Cloudflare scaffold、補助ドキュメントを生成
- `auth login|logout|status` - 認証情報の保存 / 削除 / 確認
- `index` - `.lazyload/index.json` を作成
- `watch` - ファイル変更を監視して再 index
- `stats` - local / remote の統計を表示
- `query` - symbol 検索や function / class / trace を取得
- `overview` - index 全体の概要を表示
- `sync` - local index を Cloudflare backend へ送信
- `status` - local / remote の状態確認
- `config inspect` - 解決済み設定と source を表示
- `doctor` - よくある設定ミスを診断

### 13 compatibility commands

- `list-files`
- `list-functions`
- `search-symbols`
- `get-function`
- `get-class`
- `get-related-context`
- `find-references`
- `trace-calls`
- `trace-types`
- `get-module-dependencies`
- `get-architecture-overview`
- `suggest-related`
- `sync-index`

## ローカルだけで使う場合

Cloudflare は不要です。`index`, `watch`, `stats`, `query`, `overview` はローカル index だけで動きます。

```bash
lazyload-cloud init --yes
lazyload-cloud index
lazyload-cloud query symbols render --format compact
```

## Cloudflare Worker を使う場合

`init` で `cloudflare/` ディレクトリが生成されます。

- `worker.ts` - bundled Worker handler の re-export
- `wrangler.toml` - Worker 用設定
- `migrations/0001_init.sql` - D1 schema

deploy 例:

```bash
wrangler d1 migrations apply lazyload-cloud
wrangler deploy
```

認証設定:

```bash
lazyload-cloud auth login \
  --api-base-url https://api.example.com \
  --worker-token <worker-bearer-token> \
  --cloudflare-api-token <cloudflare-api-token>
```

## D1 / R2 直結モード（Worker 不要）

Worker を deploy せずに、CLI から直接 D1 / R2 を使えます。  
この場合は **R2 に artifact を保存**し、必要に応じて **D1 に project metadata を保存**します。

```bash
lazyload-cloud auth login \
  --account-id <cloudflare-account-id> \
  --d1-database-id <d1-database-id> \
  --r2-bucket <r2-bucket-name> \
  --r2-access-key-id <r2-access-key-id> \
  --r2-secret-access-key <r2-secret-access-key> \
  --cloudflare-api-token <cloudflare-api-token>
```

`--cloudflare-api-token` は D1 更新・参照に使います。  
R2 だけ使うなら必須ではありませんが、`status` などで D1 metadata を使うなら設定した方が便利です。

direct mode の認証情報が揃っている場合、CLI は自動的に direct mode を選びます。明示したい場合は次のように指定できます。

```bash
lazyload-cloud sync --remote-mode direct
```

### direct mode に必要な値

| 用途 | env var | CLI flag |
| --- | --- | --- |
| Cloudflare Account ID | `LAZYLOAD_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` | `--account-id` |
| D1 Database ID | `LAZYLOAD_D1_DATABASE_ID` | `--d1-database-id` |
| R2 Bucket 名 | `LAZYLOAD_R2_BUCKET` | `--r2-bucket` |
| R2 Access Key ID | `LAZYLOAD_R2_ACCESS_KEY_ID` | `--r2-access-key-id` |
| R2 Secret Access Key | `LAZYLOAD_R2_SECRET_ACCESS_KEY` | `--r2-secret-access-key` |
| Cloudflare API Token | `LAZYLOAD_CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_API_TOKEN` | `--cloudflare-api-token` |

### D1 schema の投入

direct mode で D1 metadata も使うなら、最初に migration を一度流してください。

```bash
wrangler d1 execute <DB_NAME> --file cloudflare/migrations/0001_init.sql
```

## 設定の優先順位

すべての runtime 設定は次の順で解決されます。

1. CLI flags
2. `--env-file`
3. `process.env`
4. user config (`auth.json`)
5. project config (`lazyload.config.json`)
6. default

`.env` は自動ロードされません。必要なら明示的に `--env-file` を渡してください。

## 利用できる主な env var

### 共通

- `LAZYLOAD_PROJECT_ID`
- `LAZYLOAD_PREFER_REMOTE`
- `LAZYLOAD_UPLOAD_SOURCE`
- `LAZYLOAD_ENV_FILE`
- `LAZYLOAD_REMOTE_MODE` (`worker` or `direct`)
- `LAZYLOAD_CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN`

### Worker mode

- `LAZYLOAD_API_BASE_URL`
- `LAZYLOAD_API_TOKEN`

### direct mode

- `LAZYLOAD_ACCOUNT_ID`
- `CLOUDFLARE_ACCOUNT_ID`
- `LAZYLOAD_D1_DATABASE_ID`
- `LAZYLOAD_R2_BUCKET`
- `LAZYLOAD_R2_ACCESS_KEY_ID`
- `LAZYLOAD_R2_SECRET_ACCESS_KEY`

## Agent Skills

この package は `skills/` を同梱しています。

- `skills/lazyload-cloud/` - 汎用 query skill
- `skills/lazyload-cloud-project/` - project 探索向け skill
- `skills/lazyload-cloud-sync/` - auth / sync / remote 用 skill

`init` 実行時に `.claude/skills/` へ展開されます。

### `gh skill` で使う場合

```bash
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --pin v0.1.4 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-project --pin v0.1.4 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-sync --pin v0.1.4 --agent claude-code
```

最新版追従なら:

```bash
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --agent claude-code
```

## Benchmarks

再実行可能な benchmark helper を同梱しています。

```bash
npm run build
npm run bench:quick -- /path/to/project
npm run bench:compare -- /path/to/project render
```

出力は JSON です。

## Devbox

この repository には `devbox.json` が入っているので、`devbox shell` に入れば `node`, `npm`, `gh`, `bun` が使えます。

```bash
cd lazyload_cli
devbox shell
npm -v
npm install -g lazyload-cloud
```

repo 外の通常 shell でも `node` / `npm` を使いたい場合:

```bash
devbox global add nodejs@22
source ~/.bashrc
npm -v
```
