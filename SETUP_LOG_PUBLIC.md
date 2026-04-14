# Nova Sonic Voice Chat - セットアップログ & 学んだこと

## やったこと

### 1. アプリ開発 (Vite + TypeScript)

- フロントエンド: Vite + TypeScript (Vanilla) でマイク入力 → WebSocket → 音声再生の UI を構築
- バックエンド: Node.js + Express + ws で WebSocket プロキシサーバーを構築
- Nova Sonic の bidirectional streaming API をブラウザから直接呼べないため、EC2 上の Node.js サーバーが中継役

### 2. Nova Sonic 連携

- AWS SDK v3 の `InvokeModelWithBidirectionalStreamCommand` を使用
- 入力: async generator で sessionStart → promptStart → systemPrompt → audioInput を順次送信
- 出力: async iterable でレスポンスを受信し、テキスト/音声を WebSocket 経由でブラウザに返す
- 音声フォーマット: 入力 16kHz PCM16 mono / 出力 24kHz PCM16 mono / base64 エンコード

### 3. 音質改善

- 問題: `onended` コールバックで次チャンクを再生 → チャンク間にギャップ発生
- 解決: チャンク到着時に即座に `nextTime` でスケジュールするギャップレス再生方式に変更

### 4. AWS インフラ構築

#### EC2 (バックエンド)
- インスタンス: t4g.micro (ARM), Amazon Linux 2023, ap-northeast-1a
- IAM ロール: `nova-sonic-ec2-role` (AmazonBedrockFullAccess)
- セキュリティグループ: `nova-sonic-sg` (SSH, HTTP:3001, HTTPS:443)

#### ALB (SSL 終端)
- ALB 名: `nova-sonic-alb`
- セキュリティグループ: `nova-sonic-alb-sg` (HTTPS:443)
- ターゲットグループ: `nova-sonic-tg` (HTTP:3001, ヘルスチェック: /health)
- HTTPS リスナー (443) → EC2:3001 に転送
- アイドルタイムアウト: 3600秒 (WebSocket 用)

#### ACM (SSL 証明書)
- DNS 検証 (Route53 で CNAME レコード追加)

#### Route53
- API サブドメイン → ALB の Alias レコード

#### Amplify Hosting (フロントエンド)
- 手動デプロイ (zip アップロード) → GitHub 連携に移行予定

## 学んだこと・ハマったポイント

### Nova Sonic API
- HTTP/2 bidirectional streaming を使うため、ブラウザから直接呼べない → バックエンドプロキシが必須
- AWS 認証情報をブラウザに置くのはセキュリティ NG → EC2 の IAM ロールで認証
- モデル ID: `amazon.nova-sonic-v1:0` (v1 は東京リージョン対応済み)
- `amazon.nova-sonic-v2:0` は東京で使えなかった (モデル ID が無効)

### ネットワーク
- 会社ネットワークは非標準ポート (3001等) のアウトバウンドをブロックする → 443 を使う
- EC2 の Express サーバーはデフォルトで localhost のみ listen → `0.0.0.0` を明示的に指定する必要あり

### SSL / Mixed Content
- Amplify (HTTPS) から `ws://` (非暗号化) への接続はブラウザがブロック (Mixed Content)
- 自己署名証明書は WebSocket 接続でも拒否される
- 正しい解決: ALB + ACM で正規の SSL 証明書を使う

### SSL 証明書の仕組み
- 証明書には ドメイン名、公開鍵、発行者、有効期限、デジタル署名 が含まれる
- デジタル署名 (チェックサムとは異なる) で改竄を検知
- ACM が認証局として証明書を発行、ブラウザは Amazon Trust Services を信頼している

### ALB
- ヘルスチェックのデフォルトパスは `/` → サーバーが `/health` にしか応答しない場合は変更が必要
- WebSocket 用にアイドルタイムアウトを長く設定 (デフォルト60秒 → 3600秒)

### GitLab (gitlab.aws.dev)
- HTTPS での git clone は不可 (SSH のみ)
- SSH ホストは `ssh.gitlab.aws.dev`
- Amplify の標準 GitLab 連携は `gitlab.com` 向け、社内 GitLab には非対応
- `mwinit -f` で Midway 認証 → SSH 鍵が有効化される

### その他
- `scp` コマンドで SSH 経由のファイル転送 (WinSCP のコマンドライン版)
- EC2 から GitLab clone できない場合は scp/tar で転送
- `nohup ... &` でバックグラウンド実行 (SSH 切断後も継続)

## 未解決の課題

- Bedrock への接続が毎回遅い (要調査: ALB 経由の問題か Bedrock 自体の問題か)
- Amplify デプロイを GitHub 連携で CI/CD 化
- 本番化に向けて: 認証 (Cognito)、会話履歴 DB (DynamoDB)、EC2 の自動復旧

## アーキテクチャ (最終構成)

```
ブラウザ (Amplify Hosting)
  ↕ wss:// (WebSocket over TLS)
ALB (ACM 証明書で SSL 終端)
  ↕ http:// (ポート 3001)
EC2 (Node.js WebSocket プロキシ)
  ↕ HTTP/2 Bidirectional Stream
Amazon Bedrock (Nova Sonic v1, ap-northeast-1)
```
