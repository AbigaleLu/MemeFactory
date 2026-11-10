#!/bin/zsh
set -e
cd -- "${0:A:h}"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ -x .venv/bin/python ]]; then
  meme_python="$PWD/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  meme_python="$(command -v python3)"
else
  print "MemeFactory 需要 Python 3.11 或以上，请先安装 Python。"
  read -r "?按回车关闭…"
  exit 1
fi

if ! "$meme_python" -c 'import PIL; import sys; assert sys.version_info >= (3, 11)' >/dev/null 2>&1; then
  print "正在为 MemeFactory 创建项目独立环境并安装 Pillow…"
  "$meme_python" -m venv .venv
  meme_python="$PWD/.venv/bin/python"
  "$meme_python" -m pip install -r requirements.txt
fi

"$meme_python" app.py || {
  print "启动未完成，请查看上方提示。"
  read -r "?按回车关闭…"
}
