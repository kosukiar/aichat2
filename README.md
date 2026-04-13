# Nova Sonic Voice Chat

Amazon Nova Sonic を使ったリアルタイム音声会話アプリ。

## 技術構成

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Vite + TypeScript (Vanilla) |
| バックエンド | Node.js + Express + ws (WebSocket) |
| AI モデル | Amazon Nova Sonic v2 (`amazon.nova-sonic-v2:0`) |
| AWS SDK | `@aws-sdk/client-bedrock-runtime` (JS v3) |
| ホスティング | AWS Amplify Hosting (フロントエンド) |

## アーキテクチャ

```
ブラウザ (マイク入力)
  ↕ WebSocket (PCM16 base64)
Node.js サーバー (server/index.mjs)
  ↕ HTTP/2 Bidirectional Stream
Amazon Bedrock (Nova Sonic)
```

- ブラウザで 16kHz モノラル PCM16 を収録し、base64 エンコードして WebSocket で送信
- バックエンドが AWS SDK の `InvokeModelWithBidirectionalStream` で Nova Sonic に中継
- Nova Sonic からの音声レスポンス (24kHz PCM16) をブラウザに返して再生
- テキストの書き起こし (ASR / レスポンス) もリアルタイム表示

## 前提条件

- Node.js >= 20.x
- AWS CLI 設定済み (`aws configure`)
- Amazon Bedrock で Nova Sonic v2 モデルが有効化済み (ap-northeast-1)

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
| `VITE_WS_URL` | WebSocket 接続先 (フロント用) | `ws://localhost:3001` |

## Amplify Hosting デプロイ (フロントエンドのみ)

1. Amplify コンソールで「Host web app」を選択
2. Git リポジトリを接続
3. ビルド設定は `amplify.yml` が自動検出される
4. `VITE_WS_URL` 環境変数にバックエンドの WebSocket URL を設定

> **注意**: バックエンドサーバーは別途 EC2 / ECS / Lambda Web Adapter 等でホストする必要があります。
> Amplify Hosting はフロントエンドの静的ファイル配信のみです。

## ファイル構成

```
aichat2/
├── README.md               # このファイル
├── amplify.yml             # Amplify ビルド設定
├── .gitignore
└── nova-sonic-app/
    ├── server/
    │   └── index.mjs       # WebSocket プロキシサーバー
    ├── src/
    │   ├── main.ts          # フロントエンド エントリポイント
    │   ├── audio-utils.ts   # マイク収録 / 音声再生ユーティリティ
    │   └── style.css        # スタイル
    ├── index.html           # HTML テンプレート
    ├── vite.config.ts       # Vite 設定
    ├── tsconfig.json        # TypeScript 設定
    └── package.json
```
