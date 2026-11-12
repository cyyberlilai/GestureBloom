#!/usr/bin/env python3
"""
本地预览服务器 —— 相比 python -m http.server 多做了两件事：
1. 关掉缓存，避免浏览器一直显示旧版本
2. 固定监听 127.0.0.1:8801（摄像头需要 localhost 或 https）
"""
import http.server
import os
import socketserver

PORT = 8801
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"→ http://localhost:{PORT}")
        httpd.serve_forever()
