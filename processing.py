"""Local media operations for MemeFactory. Originals are always read-only."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Callable

from PIL import Image, ImageChops, ImageDraw, ImageOps, UnidentifiedImageError

MAX_PIXELS = 25_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
Progress = Callable[[int, str], None]
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".gif"}


class MediaError(ValueError):
    pass


def number(options: dict, key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(options.get(key, default))
    except (TypeError, ValueError):
        raise MediaError(f"参数 {key} 不是有效数字。") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise MediaError(f"参数 {key} 需要在 {low:g}–{high:g} 之间。")
    return value


def tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise MediaError(f"未找到 {name}，请先安装 FFmpeg（macOS：brew install ffmpeg）。")
    return path


def run(command: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(command, capture_output=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired:
        raise MediaError("处理超时，请缩短片段或选择更小的素材。") from None
    except subprocess.CalledProcessError:
        raise MediaError("无法解码或处理这份素材，请确认格式受支持、文件完整且片段范围有效。") from None


def video_info(path: Path) -> dict:
    raw = run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,duration:format=duration",
               "-of", "json", str(path)], 30)
    data = json.loads(raw.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise MediaError("素材中没有可处理的视频画面。")
    stream = streams[0]
    duration = float(data.get("format", {}).get("duration") or stream.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise MediaError("无法读取素材时长。")
    return {"kind": "video", "width": int(stream["width"]),
            "height": int(stream["height"]), "duration": round(duration, 3)}


def inspect_media(path: Path) -> dict:
    try:
        with Image.open(path) as image:
            if image.width * image.height > MAX_PIXELS:
                raise MediaError("图片超过 2500 万像素，请先缩小后重试。")
            if getattr(image, "n_frames", 1) > 1:
                if path.suffix.lower() == ".gif":
                    return video_info(path)
                raise MediaError("暂不支持此格式的动态图，请使用 GIF 或视频。")
            image = ImageOps.exif_transpose(image)
            return {"kind": "image", "width": image.width, "height": image.height,
                    "format": image.format or path.suffix.lstrip(".").upper()}
    except (UnidentifiedImageError, OSError):
        if path.suffix.lower() in VIDEO_EXTENSIONS:
            return video_info(path)
        raise MediaError("无法读取图片。支持 PNG、JPG、WebP、BMP；视频支持 MP4、MOV、WebM、GIF 等。") from None
    except Image.DecompressionBombError:
        raise MediaError("图片超过 2500 万像素，请先缩小后重试。") from None


def load_still(path: Path) -> Image.Image:
    try:
        with Image.open(path) as source:
            if source.width * source.height > MAX_PIXELS:
                raise MediaError("图片超过 2500 万像素，请先缩小后重试。")
            if getattr(source, "n_frames", 1) > 1:
                raise MediaError("此功能处理静态图片；动态图请使用「视频转 GIF」。")
            return ImageOps.exif_transpose(source).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise MediaError("图片无法读取或尺寸过大。") from None


def remove_white(path: Path, output: Path, options: dict, progress: Progress) -> dict:
    threshold = int(number(options, "threshold", 245, 200, 255))
    softness = int(number(options, "softness", 20, 0, 60))
    mode = options.get("scope", "edges")
    if mode not in {"edges", "all"}:
        raise MediaError("未知的去白底模式。")
    image = load_still(path)
    progress(15, "识别与边缘相连的白色背景")
    red, green, blue, original_alpha = image.split()
    whiteness = ImageChops.darker(ImageChops.darker(red, green), blue)
    low = max(0, threshold - softness)
    candidate = whiteness.point(lambda value: 255 if value >= low else 0)
    if mode == "edges":
        # A padded white ring connects all four edges, while enclosed white stays intact.
        padded = Image.new("L", (image.width + 2, image.height + 2), 255)
        padded.paste(candidate, (1, 1))
        ImageDraw.floodfill(padded, (0, 0), 128)
        connected = padded.crop((1, 1, image.width + 1, image.height + 1))
        candidate = connected.point(lambda value: 255 if value == 128 else 0)
    progress(55, "柔化边缘并消除白边")
    if softness:
        matte = whiteness.point(lambda value: round(255 * min(1, max(0, (threshold - value) / softness))))
    else:
        matte = whiteness.point(lambda value: 0 if value >= threshold else 255)
    matte = Image.composite(matte, Image.new("L", image.size, 255), candidate)
    # Remove the white contribution before compositing on a different background.
    # Pixel access is bounded by the input's 25 MP limit and retains existing alpha.
    pixels = image.load()
    matte_pixels = matte.load()
    old_alpha = original_alpha.load()
    changed = 0
    for y in range(image.height):
        for x in range(image.width):
            alpha = matte_pixels[x, y]
            if alpha == 255:
                continue
            changed += 1
            if alpha == 0:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                r, g, b, _ = pixels[x, y]
                clean = tuple(max(0, min(255, round((c * 255 - 255 * (255 - alpha)) / alpha))) for c in (r, g, b))
                pixels[x, y] = (*clean, round(old_alpha[x, y] * alpha / 255))
    progress(90, "保存透明 PNG")
    image.save(output, "PNG", optimize=True)
    return {"width": image.width, "height": image.height, "format": "PNG",
            "changed_pixels": changed,
            "note": "已导出透明 PNG。" if changed else "没有检测到符合阈值的白底，可提高柔化范围或切换全图模式。"}


def compress_image(path: Path, output: Path, options: dict, progress: Progress) -> dict:
    max_edge = int(number(options, "max_edge", 512, 32, 4096))
    budget = int(number(options, "max_kb", 500, 10, 5000) * 1000)
    file_format = options.get("format", "webp")
    if file_format not in {"webp", "png", "jpeg"}:
        raise MediaError("请选择 WebP、PNG 或 JPG。")
    image = load_still(path)
    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    if file_format == "jpeg":
        canvas = Image.new("RGB", image.size, "white")
        canvas.paste(image, mask=image.getchannel("A"))
        image = canvas
    progress(10, "等比缩小，寻找合适的导出质量")
    quality = 92
    for attempt in range(20):
        save_options = {"optimize": True} if file_format == "png" else {"quality": quality}
        if file_format == "webp":
            save_options["method"] = 6
        if file_format == "jpeg":
            save_options.update(optimize=True, progressive=True)
        image.save(output, file_format.upper(), **save_options)
        size = output.stat().st_size
        if size < budget:
            return {"width": image.width, "height": image.height,
                    "format": file_format.upper(), "quality": quality if file_format != "png" else None,
                    "note": "已达到体积目标。" + ("JPG 已使用白色填充透明区域。" if file_format == "jpeg" else "")}
        progress(min(90, 20 + attempt * 4), "继续优化体积，保留画面比例")
        if file_format != "png" and quality > 44:
            quality -= 12
        else:
            new_size = tuple(max(1, round(v * 0.78)) for v in image.size)
            if new_size == image.size:
                break
            image = image.resize(new_size, Image.Resampling.LANCZOS)
            quality = 80
    output.unlink(missing_ok=True)
    raise MediaError("当前体积目标无法达到，请提高目标大小。")


def gif_profiles(width: int, fps: int):
    profiles = [(1, 1, 256), (1, 1, 128), (0.85, 1, 96), (0.75, 0.85, 80),
                (0.65, 0.75, 64), (0.55, 0.65, 48), (0.45, 0.5, 32),
                (0.35, 0.4, 24), (0.25, 0.3, 16), (0, 0, 16)]
    for width_ratio, fps_ratio, colors in profiles:
        yield (max(32, round(width * width_ratio)), max(2, round(fps * fps_ratio)), colors)


def make_gif(path: Path, output: Path, options: dict, progress: Progress) -> dict:
    info = video_info(path)
    start = number(options, "start", 0, 0, max(0, info["duration"] - 0.04))
    duration = number(options, "duration", 3, 0.1, 15)
    duration = min(duration, info["duration"] - start)
    width = min(int(number(options, "width", 320, 64, 720)), max(info["width"], info["height"]))
    fps = int(number(options, "fps", 12, 4, 24))
    budget = int(number(options, "max_kb", 500, 50, 500) * 1000)
    for attempt, (edge, rate, colors) in enumerate(gif_profiles(width, fps)):
        progress(8 + attempt * 9, f"第 {attempt + 1} 次编码 · 长边 {edge}px · {rate}fps · {colors} 色")
        # Fit both dimensions, including portrait and rotated video. Never upscale.
        filters = (f"fps={rate},scale=w='min(iw,{edge})':h='min(ih,{edge})':"
                   "force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];"
                   f"[a]palettegen=max_colors={colors}:reserve_transparent=1:stats_mode=diff[p];"
                   "[b][p]paletteuse=dither=bayer:bayer_scale=3")
        run([tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-ss", str(start), "-i", str(path), "-t", str(duration),
             "-filter_complex_threads", "1", "-filter_complex", filters,
             "-an", "-loop", "0", str(output)], 120)
        if output.stat().st_size < budget:
            with Image.open(output) as result:
                actual_duration = sum(frame_duration(result, i) for i in range(result.n_frames)) / 1000
                dimensions = {"width": result.width, "height": result.height}
            return {**dimensions, "format": "GIF", "fps": rate, "colors": colors,
                    "duration": round(actual_duration, 2), "attempts": attempt + 1,
                    "note": f"已低于 {budget // 1000} KB，保留所选片段，自动循环播放。"}
    output.unlink(missing_ok=True)
    raise MediaError("尝试压缩后仍超出目标。请缩短片段或提高体积目标；没有导出超标文件。")


def frame_duration(image: Image.Image, index: int) -> int:
    image.seek(index)
    return image.info.get("duration", 0)
