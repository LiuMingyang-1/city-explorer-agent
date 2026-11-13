"""Local Chinese poster OCR. JSON stdin/stdout; no credentials or image uploads.

Install scripts/requirements-ocr.txt in the existing isolated collector venv.
Only known XHS image-CDN HTTPS hosts are fetched; redirects are rejected.
"""
import io
import json
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image
from rapidocr_onnxruntime import RapidOCR


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    urls = json.loads(sys.stdin.read(65536))
    if not isinstance(urls, list) or len(urls) > 20:
        raise ValueError("INVALID_IMAGE_INPUT")
    started = time.monotonic()
    engine = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    opener = urllib.request.build_opener(NoRedirect)
    pages = []
    Image.MAX_IMAGE_PIXELS = 25_000_000
    for index, value in enumerate(urls):
        page = {"image": index + 1, "text": "", "error": None}
        try:
            u = urllib.parse.urlsplit(value)
            if u.scheme not in ("https", "http") or u.username or u.password or u.port or not u.hostname or not u.hostname.endswith(".xhscdn.com"):
                raise ValueError("IMAGE_HOST_NOT_ALLOWED")
            # Upgrade CDN links to HTTPS; do not forward cookies or API keys.
            url = urllib.parse.urlunsplit(("https", u.netloc, u.path, u.query, ""))
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10) as response:
                raw = response.read(12 * 1024 * 1024 + 1)
            if len(raw) > 12 * 1024 * 1024:
                raise ValueError("IMAGE_TOO_LARGE")
            with Image.open(io.BytesIO(raw)) as image:
                image = image.convert("RGB")
                image.thumbnail((1800, 2400))
                import numpy as np
                rows, _ = engine(np.asarray(image))
            page["text"] = "\n".join(row[1] for row in rows or [] if row[2] >= 0.5)[:12000]
        except Exception as error:
            page["error"] = str(error) if isinstance(error, ValueError) and str(error).isupper() else "IMAGE_OCR_FAILED"
        pages.append(page)
    print(json.dumps({"pages": pages, "elapsed_ms": round((time.monotonic()-started)*1000)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
