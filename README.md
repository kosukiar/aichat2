# Nova Sonic Voice Chat

Amazon Nova Sonic を使ったリアルタイム音声会話アプリ。

## 技術構成

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Vite + TypeScript (Vanilla) |
| バックエンド | Node.js + Express + ws (WebSocket) |
| AI モデル | Amazon Nova Sonic (`amazon.nova-sonic-v1:0`) |
| AWS SDK | `@aws-sdk/client-bedrock-runtime` (JS v3) |
| ホスティング (フロント) | AWS Amplify Hosting |
| ホスティング (バックエンド) | EC2 + ALB |
| SSL 証明書 | ACM (AWS Certificate Manager) |
| DNS | Route53 |

## アーキテクチャ

```
ブラウザ (Amplify Hosting)
  ↕ wss:// (WebSocket over TLS)
ALB (ACM 証明書で SSL 終端)
  ↕ http:// (ポート 3001)
EC2 (Node.js WebSocket プロキシサーバー)
  ↕ HTTP/2 Bidirectional Stream
Amazon Bedrock (Nova Sonic v1, ap-northeast-1)
```

- ブラウザで 16kHz モノラル PCM16 を収録し、base64 エンコードして WebSocket (wss://) で送信
- ALB が SSL を終端し、EC2 には HTTP で転送
- EC2 上の Node.js サーバーが AWS SDK の `InvokeModelWithBidirectionalStream` で Nova Sonic に中継
- Nova Sonic からの音声レスポンス (24kHz PCM16) をブラウザに返して再生
- テキストの書き起こし (ASR / レスポンス) もリアルタイム表示

## 前提条件

- Node.js >= 20.x
- AWS アカウント (Bedrock, EC2, ALB, ACM, Route53, Amplify)
- Amazon Bedrock で Nova Sonic モデルが有効化済み (ap-northeast-1)

## AWS リソース一覧

| リソース | 名前 | 備考 |
|---------|------|------|
| EC2 | nova-sonic-server | t4g.micro, Amazon Linux 2023 |
| IAM ロール | nova-sonic-ec2-role | AmazonBedrockFullAccess |
| SG (EC2) | nova-sonic-sg | 22, 3001, 443 |
| SG (ALB) | nova-sonic-alb-sg | 443 |
| ALB | nova-sonic-alb | ap-northeast-1 |
| ターゲットグループ | nova-sonic-tg | HTTP:3001, ヘルスチェック: /health |
| ACM 証明書 | api.kosukiar.people.aws.dev | DNS 検証済み |
| Route53 | api.kosukiar.people.aws.dev → ALB | Alias レコード |
| Amplify | nova-sonic-app | GitHub 連携 |

## ローカル開発

```bash
cd nova-sonic-app

# 依存関係インストール
npm install

# ターミナル1: バックエンドサーバー起動
npm run dev:server

# ターミナル2: フロントエンド開発サーバー起動
npm run dev
```

ブラウザで http://localhost:5173 を開き、マイクボタンを押して会話開始。

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `AWS_REGION` | AWS リージョン | `ap-northeast-1` |
| `PORT` | バックエンドポート | `3001` |
| `VITE_WS_URL` | WebSocket 接続先 (フロント用) | `wss://api.kosukiar.people.aws.dev` |

## デプロイ手順

### フロントエンド (Amplify)

```bash
cd nova-sonic-app
VITE_WS_URL=wss://api.kosukiar.people.aws.dev npx vite build
cd dist
zip -r /tmp/nova-sonic-dist.zip .
```

Amplify コンソールで「アップデートをデプロイ」→ zip をアップロード。

### バックエンド (EC2)

```bash
# ファイル転送
scp -i ~/.ssh/<keypair>.pem nova-sonic-app/server/index.mjs ec2-user@<EC2_IP>:~/nova-sonic-app/server/index.mjs

# サーバー再起動
ssh -i ~/.ssh/<keypair>.pem ec2-user@<EC2_IP> \
  "kill \$(lsof -t -i:3001) 2>/dev/null; cd ~/nova-sonic-app && nohup node server/index.mjs > /tmp/nova-sonic.log 2>&1 &"
```

## ファイル構成

```
aichat2/
├── README.md               # このファイル
├── SETUP_LOG.md            # セットアップログ & 学んだこと
├── amplify.yml             # Amplify ビルド設定
├── .gitignore
└── nova-sonic-app/
    ├── server/
    │   ├── index.mjs       # WebSocket プロキシサーバー
    │   └── setup-ec2.sh    # EC2 セットアップスクリプト
    ├── src/
    │   ├── main.ts          # フロントエンド エントリポイント
    │   ├── audio-utils.ts   # マイク収録 / 音声再生ユーティリティ
    │   └── style.css        # スタイル
    ├── index.html           # HTML テンプレート
    ├── vite.config.ts       # Vite 設定
    ├── tsconfig.json        # TypeScript 設定
    └── package.json
```
