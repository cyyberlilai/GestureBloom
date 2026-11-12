#!/bin/zsh
# 双击运行：启动本地服务器并打开页面（摄像头需要 localhost）
cd "$(dirname "$0")" || exit 1
PORT=8801

if [ ! -f serve.py ] || [ ! -f index.html ]; then
  echo "✗ 没找到 serve.py / index.html"
  echo "  请确认「启动.command」和它们放在同一个文件夹里。"
  echo "按回车关闭窗口"
  read -r _
  exit 1
fi

# 端口上如果有旧进程，先关掉 —— 否则你打开的可能是上一个版本
if lsof -ti:$PORT >/dev/null 2>&1; then
  echo "· 关闭占用 $PORT 的旧进程"
  lsof -ti:$PORT | xargs kill 2>/dev/null
  sleep 0.8
fi

# 每次启动都带一个唯一参数，浏览器无法复用旧缓存
STAMP=$(date +%s)
URL="http://localhost:$PORT/?t=$STAMP"
echo "→ $URL"
( sleep 1; open "$URL" ) &

python3 serve.py
echo ""
echo "服务已停止。按回车关闭窗口。"
read -r _
