# lazyload-cloud

[English README](./README.md)

`lazyload-cloud` は、ローカルコードベースからコンパクトなコードコンテキストを作成・検索するための Node CLI です。**TypeScript / JavaScript / Python** を index 化し、必要な情報だけを素早く取り出せます。

このリポジトリの実装は、次の 3 モードで使えます。

1. **ローカルモード** — ローカル index だけを使う
2. **Worker モード** — Cloudflare Worker API 経由で remote 利用する
3. **direct D1/R2 モード** — Worker を deploy せず、CLI から D1 / R2 に直接アクセスする

## 必要環境

- **Node.js 20 以上**

## インストール

```bash
npm install -g lazyload-cloud@0.1.4
```

`npx lazyload-cloud` でも利用できます。

## このリポジトリが提供するもの

- CLI package: `lazyload-cloud`
- Worker export: `lazyload-cloud/worker`
- Agent Skills: `skills/`
- benchmark scripts: `benchmarks/`

## 主な機能

- TypeScript / JavaScript / Python の index 作成
- `.lazyload/index.json` へのローカル保存
- `json` / `compact` / `markdown` 出力
- 以下の query 機能
  - symbol 検索
  - function / class 取得
  - related context
  - references
  - call trace
  - type trace
  - module dependencies
  - architecture overview
  - stats
- `watch` による自動再 index
- `init` による skills / Cloudflare scaffold 生成

## クイックスタート

```bash
lazyload-cloud init --yes
lazyload-cloud index
lazyload-cloud stats --format compact
lazyload-cloud query symbols handler --format compact
lazyload-cloud overview --format compact
```

## 主なコマンド

| コマンド | 役割 |
| --- | --- |
| `init` | `lazyload.config.json`、skills、Cloudflare scaffold、補助ドキュメントを生成 |
| `auth login` / `logout` / `status` | 認証情報の保存 / 削除 / 確認 |
| `index` | ローカル index を作成 |
| `watch` | 変更監視しながら再 index |
| `stats` | ローカルまたは remote の統計を表示 |
| `query` | 主な query surface |
| `overview` | プロジェクト全体の概要表示 |
| `sync` | 現在の index を remote backend に送信 |
| `status` | local / remote の状態確認 |
| `config inspect` | 解決済み設定と source を表示 |
| `doctor` | よくある設定ミスの診断 |

## Query surface

### primary query commands

- `query symbols <query>`
- `query function <name>`
- `query class <name>`
- `query related-context <name>`
- `query references <name>`
- `query calls <name>`
- `query types <name>`
- `query module-dependencies <module-path>`
- `query suggest-related <name>`

### compatibility commands

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

## ローカルモード

ローカルモードでは Cloudflare は不要です。

```bash
lazyload-cloud init --yes
lazyload-cloud index
lazyload-cloud query symbols render --format compact
```

ローカル index が無い場合は、`lazyload-cloud index` を実行するよう明示的なエラーが返ります。

## 設定ファイル

プロジェクト設定は `lazyload.config.json` に保存されます。

既定値:

- directories: `["."]`
- output path: `.lazyload/index.json`
- include:
  - `**/*.ts`
  - `**/*.tsx`
  - `**/*.js`
  - `**/*.jsx`
  - `**/*.py`
- exclude:
  - `node_modules`
  - `dist`
  - `build`
  - `.git`
  - `coverage`
  - `venv`
  - `__pycache__`
  - ほか一般的な生成物

ユーザー向けに重要な設定:

- `remote.projectId`
- `remote.preferRemote`
- `privacy.uploadSource`

`privacy.uploadSource=false` のとき、remote sync では symbol の source / documentation は upload されません。

## 認証と設定解決

保存される auth file:

- `~/.config/lazyload-cloud/auth.json`
- または `$XDG_CONFIG_HOME/lazyload-cloud/auth.json`

このファイルは **`0600`** で保存されます。

設定解決の優先順位:

1. CLI flags
2. `--env-file`
3. `process.env`
4. user auth file
5. project config
6. default

`.env` は自動ロードされません。必要なら `--env-file` を使ってください。

## Worker モード

Worker モードでは、deploy 済み Cloudflare Worker API を remote backend として使います。

### 必要な値

- API base URL
- Worker bearer token

### 例

```bash
lazyload-cloud auth login \
  --api-base-url https://api.example.com \
  --worker-token <worker-bearer-token> \
  --cloudflare-api-token <cloudflare-api-token>
```

Worker モードで remote API 認証に使うのは **worker token** です。

## direct D1/R2 モード

direct モードでは Worker を挟まず、CLI から D1 / R2 に直接アクセスします。

### 必要な値

- Cloudflare account ID
- D1 database ID
- R2 bucket name
- R2 access key ID
- R2 secret access key

任意:

- Cloudflare API token

Cloudflare API token は D1 metadata の読み書きに使います。R2 へのアクセスは S3 互換 credential を使います。

### 例

```bash
lazyload-cloud auth login \
  --account-id <cloudflare-account-id> \
  --d1-database-id <d1-database-id> \
  --r2-bucket <r2-bucket-name> \
  --r2-access-key-id <r2-access-key-id> \
  --r2-secret-access-key <r2-secret-access-key> \
  --cloudflare-api-token <cloudflare-api-token>
```

### remote mode の選択

5 つの direct credential が揃っていると、自動的に direct mode が選ばれます。明示する場合:

```bash
lazyload-cloud sync --remote-mode direct
```

### direct mode の重要な挙動

- `sync` は artifact を **R2** に保存する
- D1 metadata は Cloudflare API token があるときだけ使う
- direct mode の remote query は **R2 から artifact を取得し、その artifact に対して通常のローカル query helper を実行する**

### D1 schema の投入

D1 metadata も使いたい場合は、一度だけ schema を流してください。

```bash
wrangler d1 execute <DB_NAME> --file cloudflare/migrations/0001_init.sql
```

## 環境変数

### 共通

- `LAZYLOAD_PROJECT_ID`
- `LAZYLOAD_PREFER_REMOTE`
- `LAZYLOAD_UPLOAD_SOURCE`
- `LAZYLOAD_ENV_FILE`
- `LAZYLOAD_REMOTE_MODE`
- `LAZYLOAD_CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN`

### Worker モード

- `LAZYLOAD_API_BASE_URL`
- `LAZYLOAD_API_TOKEN`

### direct モード

- `LAZYLOAD_ACCOUNT_ID`
- `CLOUDFLARE_ACCOUNT_ID`
- `LAZYLOAD_D1_DATABASE_ID`
- `LAZYLOAD_R2_BUCKET`
- `LAZYLOAD_R2_ACCESS_KEY_ID`
- `LAZYLOAD_R2_SECRET_ACCESS_KEY`

## Cloudflare scaffold

`init` は `cloudflare/` ディレクトリを生成できます。

- `worker.ts`
- `wrangler.toml`
- `migrations/0001_init.sql`

生成される scaffold には D1 / R2 / Queue / Durable Object 用の設定が含まれます。

## Agent Skills

このリポジトリには 3 つの skill が含まれています。

- `skills/lazyload-cloud/`
- `skills/lazyload-cloud-project/`
- `skills/lazyload-cloud-sync/`

`init` 実行時に `.claude/skills/` へコピーされます。

生成される skill script は既定で `npx lazyload-cloud` を使います。`LAZYLOAD_CLI_BIN` を指定すると別の binary path を使えます。

### `gh skill` で直接 install する

GitHub から skills を直接入れたい場合は、次のように使えます。

```bash
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --pin v0.1.4 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-project --pin v0.1.4 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-sync --pin v0.1.4 --agent claude-code
```

固定 version ではなく最新 release を追従したい場合:

```bash
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --agent claude-code
```

## Benchmarks

benchmark script は 2 つあります。

```bash
npm run build
npm run bench:quick -- /path/to/project
npm run bench:compare -- /path/to/project render
```

- `bench:quick` - index / stats / overview の時間を測る
- `bench:compare` - 単純なファイル走査と indexed symbol search を比較する

どちらも JSON を出力します。
