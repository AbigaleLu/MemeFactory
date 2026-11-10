#!/usr/bin/env python3
"""MemeFactory: a loopback-only app with no cloud dependencies."""
from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import re
import secrets
import shutil
import tempfile
import threading
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from processing import MediaError, compress_image, inspect_media, make_gif, remove_white

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 150 * 1024 * 1024
MAX_FILES = 40


class Factory:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="memefactory-")
        self.root = Path(self.directory.name)
        self.token = secrets.token_urlsafe(32)
        self.media: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="meme")

    def process(self, job_id: str, media: dict, operation: str, options: dict):
        def progress(percent: int, message: str):
            with self.lock:
                self.jobs[job_id].update(status="working", progress=percent, message=message)
        extension = {"white": "png", "gif": "gif", "resize": options.get("format", "webp")}[operation]
        if not isinstance(extension, str) or extension not in {"png", "gif", "webp", "jpeg"}:
            extension = "webp"
        output = self.root / f"{job_id}.{extension}"
        try:
            processor = {"white": remove_white, "gif": make_gif, "resize": compress_image}[operation]
            metadata = processor(media["path"], output, options, progress)
            result = {**metadata, "bytes": output.stat().st_size,
                      "original_bytes": media["bytes"], "url": f"/result/{job_id}",
                      "filename": f"{Path(media['name']).stem}_{operation}.{extension}"}
            with self.lock:
                self.jobs[job_id].update(status="done", progress=100, message="完成", result=result, path=output)
        except (MediaError, ValueError) as error:
            output.unlink(missing_ok=True)
            with self.lock:
                self.jobs[job_id].update(status="error", message=str(error))
        except Exception:
            output.unlink(missing_ok=True)
            with self.lock:
                self.jobs[job_id].update(status="error", message="处理失败，请换一份素材或降低尺寸后重试。")

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.directory.cleanup()


class Handler(BaseHTTPRequestHandler):
    server_version = "MemeFactory/0.1"

    @property
    def factory(self) -> Factory:
        return self.server.factory

    def log_message(self, *_):
        pass  # File names and source paths stay out of logs.

    def send_headers(self, status: int, length: int, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def respond(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_headers(status, len(body), content_type, extra)
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_media(self, path: Path, extra: dict):
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        extra["Accept-Ranges"] = "bytes"
        if range_header := self.headers.get("Range"):
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or not any(match.groups()):
                return self.respond(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), end) if last else end
            else:
                start = max(0, size - int(last))
            if start >= size or start > end:
                return self.respond(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
            status = 206
            extra["Content-Range"] = f"bytes {start}-{end}/{size}"
        self.send_headers(status, end - start + 1, mimetypes.guess_type(path)[0] or "application/octet-stream", extra)
        try:
            with path.open("rb") as source:
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = source.read(min(256 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json_response(self, status: int, data: dict):
        self.respond(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def valid_host(self) -> bool:
        port = self.server.server_port
        return self.headers.get("Host") in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def do_GET(self):
        if not self.valid_host():
            return self.json_response(403, {"error": "仅允许本机访问。"})
        route = urlsplit(self.path).path
        if route == "/api/status":
            return self.json_response(200, {"name": "MemeFactory", "version": "0.1.0", "token": self.factory.token,
                                            "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                            "max_upload": MAX_UPLOAD})
        if route.startswith("/api/jobs/"):
            with self.factory.lock:
                job = self.factory.jobs.get(route.rsplit("/", 1)[-1])
                public = {k: v for k, v in job.items() if k != "path"} if job else None
            return self.json_response(200 if public else 404, public or {"error": "任务不存在。"})
        if route.startswith(("/source/", "/result/")):
            identity = route.rsplit("/", 1)[-1]
            with self.factory.lock:
                item = (self.factory.media if route.startswith("/source/") else self.factory.jobs).get(identity)
            if not item or "path" not in item or not item["path"].is_file():
                return self.json_response(404, {"error": "文件不存在，请重新选择素材。"})
            extra = {}
            if route.startswith("/result/") and urlsplit(self.path).query == "download=1":
                name = quote(item["result"]["filename"], safe="")
                extra["Content-Disposition"] = f"attachment; filename*=UTF-8''{name}"
            return self.serve_media(item["path"], extra)
        files = {"/": "index.html", "/style.css": "style.css", "/app.js": "app.js", "/favicon.svg": "favicon.svg"}
        if route in files:
            path = ROOT / "web" / files[route]
            return self.respond(200, path.read_bytes(), mimetypes.guess_type(path)[0] or "text/plain")
        return self.json_response(404, {"error": "页面不存在。"})

    def do_POST(self):
        origin = self.headers.get("Origin")
        if (not self.valid_host() or self.headers.get("X-Meme-Token") != self.factory.token
                or (origin and origin not in {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"})):
            return self.json_response(403, {"error": "请求无效，请刷新页面后重试。"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            route = urlsplit(self.path)
            if route.path == "/api/upload":
                if not 0 < length <= MAX_UPLOAD:
                    raise MediaError("请选择 150 MB 以内的文件。")
                with self.factory.lock:
                    if len(self.factory.media) >= MAX_FILES:
                        raise MediaError("本次会话已载入 40 份素材，请重启工具后继续。")
                name = parse_qs(route.query).get("name", ["素材"])[0].replace("\\", "/").rsplit("/", 1)[-1][:180]
                identity = uuid.uuid4().hex
                suffix = Path(name).suffix.lower()
                if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".gif"}:
                    raise MediaError("暂不支持这个文件类型，请选择常见图片、视频或 GIF。")
                path = self.factory.root / f"{identity}{suffix}"
                try:
                    remaining = length
                    with path.open("wb") as target:
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise MediaError("素材传输中断，请重试。")
                            target.write(chunk)
                            remaining -= len(chunk)
                    metadata = inspect_media(path)
                except Exception:
                    path.unlink(missing_ok=True)
                    raise
                public = {"id": identity, "name": name, "bytes": length, "url": f"/source/{identity}", **metadata}
                with self.factory.lock:
                    self.factory.media[identity] = {**public, "path": path}
                return self.json_response(200, public)
            if route.path == "/api/process":
                if not 0 < length <= 16_384:
                    raise MediaError("请求过大或为空。")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or not isinstance(payload.get("options", {}), dict):
                    raise MediaError("处理参数格式无效。")
                operation = payload.get("operation")
                if operation not in {"white", "gif", "resize"}:
                    raise MediaError("未知操作。")
                with self.factory.lock:
                    media = self.factory.media.get(payload.get("media_id"))
                    active = sum(job["status"] in {"queued", "working"} for job in self.factory.jobs.values())
                if not media:
                    raise MediaError("请先选择素材。")
                if active >= 4:
                    raise MediaError("正在处理的任务较多，请等当前任务完成。")
                if (operation == "gif") != (media["kind"] == "video"):
                    raise MediaError("请为当前功能选择合适的图片或视频。")
                job_id = uuid.uuid4().hex
                with self.factory.lock:
                    self.factory.jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0, "message": "等待处理"}
                self.factory.pool.submit(self.factory.process, job_id, media, operation, payload.get("options", {}))
                return self.json_response(202, {"job_id": job_id})
            return self.json_response(404, {"error": "接口不存在。"})
        except (MediaError, ValueError, TypeError, KeyError) as error:
            return self.json_response(400, {"error": str(error) or "参数无效。"})
        except Exception:
            return self.json_response(500, {"error": "无法处理请求，请重试。"})


def main():
    parser = argparse.ArgumentParser(description="MemeFactory 本机表情处理器")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    arguments = parser.parse_args()
    factory = Factory()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Handler)
    except OSError as error:
        factory.close()
        if error.errno == errno.EADDRINUSE:
            raise SystemExit(f"端口 {arguments.port} 已被占用。可以使用 --port 8766 换一个端口。")
        raise SystemExit(f"无法启动本机服务：{error}。请检查本机网络权限。")
    server.factory = factory
    url = f"http://localhost:{server.server_port}"
    print(f"MemeFactory 0.1.0\n本机地址：{url}\n按 Control+C 停止；停止后临时素材会自动清理。", flush=True)
    if not arguments.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在结束任务并清理临时素材…", flush=True)
    finally:
        server.server_close()
        factory.close()


if __name__ == "__main__":
    main()
