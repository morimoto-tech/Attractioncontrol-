プレショー同期版の使い方

1. start-preshow-server.bat を開く
2. 操作用端末で http://localhost:8787/control.html を開く
3. 表示用端末で http://同じPCのIPアドレス:8787/display.html を開く

例:
操作PCのIPアドレスが 192.168.1.20 の場合
表示用端末では http://192.168.1.20:8787/display.html

ポイント:
- 2つの端末は同じWi-Fiまたは同じローカルネットワークに置く
- 映像と音声は control.html 側で登録する
- 終了後シーンは設定秒数のあと自動で待機中へ戻る
- 表示ページは全画面ボタンで映像だけ大きく出せる
