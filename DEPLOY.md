# プレショーアプリの公開方法

このアプリは `server.js` を動かす必要があるため、静的サイトではなく Node.js アプリとして公開します。

## いちばん簡単な方法

`Render` か `Railway` がおすすめです。  
どちらも GitHub 連携でそのまま公開できます。

## 公開前にやること

1. このフォルダを GitHub にアップロードする
2. `media` フォルダは公開先で毎回初期化されることがあるので、本番素材は都度アップロードする前提で使う
3. `start` コマンドは `node server.js`

## Render の設定

1. Render にログイン
2. `New +` から `Web Service` を選ぶ
3. GitHub のこのリポジトリを選ぶ
4. 設定は以下

- Environment: `Node`
- Build Command: 空欄でOK
- Start Command: `node server.js`

5. デプロイ完了後に発行されたURLを開く

例:
- 操作ページ: `https://your-app.onrender.com/control.html`
- 表示ページ: `https://your-app.onrender.com/display.html`

## Railway の設定

1. Railway にログイン
2. `New Project` から GitHub リポジトリを選ぶ
3. 起動コマンドを `node server.js` にする
4. デプロイ後のURLで `control.html` と `display.html` を開く

## 注意点

- このアプリはアップロードした映像と音声をサーバー上の `media` フォルダに保存します
- Render や Railway では、再起動や再デプロイで保存ファイルが消えることがあります
- 試験公開ならそのままで十分です
- 本番運用では、メディア保存先を外部ストレージに変えるのが安全です

## GitHub に上げるときの最小手順

```bash
git init
git add .
git commit -m "Add preshow control app"
```

そのあと GitHub に新しいリポジトリを作って push します。
