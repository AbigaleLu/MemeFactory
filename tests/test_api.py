import io
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Factory, Handler, ThreadingHTTPServer


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.factory = Factory()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.factory = cls.factory
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.opener = build_opener(ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.factory.close()

    def request(self, path, data=None, token=True, headers=None):
        request_headers = {"X-Meme-Token": self.factory.token} if token else {}
        request_headers.update(headers or {})
        return self.opener.open(Request(self.url + path, data=data, headers=request_headers), timeout=5)

    def test_health_and_static_assets(self):
        with self.request("/api/status") as response:
            self.assertEqual(json.load(response)["version"], "0.1.0")
        for path in ["/", "/app.js", "/style.css", "/favicon.svg"]:
            with self.request(path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])

    def test_upload_process_poll_and_download(self):
        buffer = io.BytesIO()
        Image.new("RGB", (50, 50), "white").save(buffer, "PNG")
        with self.request("/api/upload?name=example.png", buffer.getvalue()) as response:
            media = json.load(response)
        body = json.dumps({"media_id": media["id"], "operation": "white", "options": {}}).encode()
        with self.request("/api/process", body) as response:
            self.assertEqual(response.status, 202)
            job_id = json.load(response)["job_id"]
        for _ in range(100):
            with self.request(f"/api/jobs/{job_id}") as response:
                job = json.load(response)
            self.assertNotIn("path", job)
            if job["status"] in {"done", "error"}:
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "done", job)
        with self.request(job["result"]["url"] + "?download=1") as response:
            self.assertIn("attachment", response.headers["Content-Disposition"])
            result_bytes = response.read()
        self.assertEqual(len(result_bytes), job["result"]["bytes"])
        with self.request(job["result"]["url"], headers={"Range": "bytes=0-7"}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), result_bytes[:8])
            self.assertTrue(response.headers["Content-Range"].startswith("bytes 0-7/"))
        with Image.open(io.BytesIO(result_bytes)) as image:
            self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_missing_token_foreign_origin_and_foreign_host_are_rejected(self):
        for token, headers in [(False, {}), (True, {"Origin": "https://example.com"}), (True, {"Host": "example.com"})]:
            with self.assertRaises(HTTPError) as error:
                self.request("/api/process", b"{}", token=token, headers=headers)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()

    def test_corrupt_file_and_unknown_operation_have_clear_errors(self):
        for path, body in [("/api/upload?name=broken.png", b"invalid"), ("/api/process", b'{"operation":"bad"}')]:
            with self.assertRaises(HTTPError) as error:
                self.request(path, body)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        self.assertEqual(len(list(self.factory.root.glob("*broken*"))), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
