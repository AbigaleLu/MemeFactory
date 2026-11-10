import hashlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from processing import MediaError, compress_image, inspect_media, make_gif, remove_white, run, tool


def quiet(*_):
    pass


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.png"
        self.output = self.root / "result.png"
        image = Image.new("RGBA", (120, 100), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 99, 79), fill=(220, 90, 40, 255))
        draw.ellipse((40, 35, 60, 55), fill="white")
        image.putpixel((30, 30), (20, 30, 40, 128))
        image.save(self.source)
        self.original_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.original_hash)
        self.temp.cleanup()

    def test_edge_removal_retains_enclosed_white_and_existing_alpha(self):
        result = remove_white(self.source, self.output, {}, quiet)
        with Image.open(self.output) as image:
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            self.assertEqual(image.getpixel((50, 45)), (255, 255, 255, 255))
            self.assertEqual(image.getpixel((30, 30)), (20, 30, 40, 128))
            self.assertEqual(image.getpixel((25, 25)), (220, 90, 40, 255))
        self.assertGreater(result["changed_pixels"], 0)

    def test_all_white_removes_interior_and_softens_edges(self):
        remove_white(self.source, self.output, {"scope": "all"}, quiet)
        with Image.open(self.output) as image:
            self.assertEqual(image.getpixel((50, 45))[3], 0)
        soft = self.root / "soft.png"
        Image.new("RGB", (10, 10), (235, 235, 235)).save(soft)
        remove_white(soft, self.output, {"threshold": 245, "softness": 20}, quiet)
        with Image.open(self.output) as image:
            self.assertEqual(image.getpixel((0, 0))[3], 128)

    def test_resize_preserves_ratio_transparency_and_does_not_upscale(self):
        result = compress_image(self.source, self.output, {"max_edge": 60, "format": "webp", "max_kb": 10}, quiet)
        self.assertEqual((result["width"], result["height"]), (60, 50))
        self.assertLess(self.output.stat().st_size, 10_000)
        with Image.open(self.output) as image:
            self.assertIn("A", image.getbands())
        result = compress_image(self.source, self.output, {"max_edge": 512, "format": "png"}, quiet)
        self.assertEqual((result["width"], result["height"]), (120, 100))

    def test_png_shrinks_to_measured_budget(self):
        noisy = self.root / "noise.png"
        Image.effect_noise((700, 500), 100).convert("RGB").save(noisy)
        result = compress_image(noisy, self.output, {"max_edge": 700, "format": "png", "max_kb": 20}, quiet)
        self.assertLess(self.output.stat().st_size, 20_000)
        self.assertLess(result["width"], 700)
        self.assertAlmostEqual(result["width"] / result["height"], 1.4, delta=0.025)

    def test_jpeg_flattens_transparency_on_white(self):
        transparent = self.root / "transparent.png"
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(transparent)
        compress_image(transparent, self.output, {"format": "jpeg"}, quiet)
        with Image.open(self.output) as image:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    def test_invalid_parameters_and_animation_are_rejected(self):
        for options in [{"threshold": float("nan")}, {"softness": -1}, {"scope": "bad"}]:
            with self.assertRaises(MediaError):
                remove_white(self.source, self.output, options, quiet)
        animated = self.root / "animated.gif"
        first, second = Image.new("RGB", (30, 30), "red"), Image.new("RGB", (30, 30), "blue")
        first.save(animated, save_all=True, append_images=[second], duration=100, loop=0)
        with self.assertRaises(MediaError):
            compress_image(animated, self.output, {}, quiet)

    def test_exif_orientation_is_applied(self):
        oriented = self.root / "oriented.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (80, 40), "red").save(oriented, exif=exif)
        self.assertEqual((inspect_media(oriented)["width"], inspect_media(oriented)["height"]), (40, 80))
        result = compress_image(oriented, self.output, {"format": "png"}, quiet)
        self.assertEqual((result["width"], result["height"]), (40, 80))

    def test_pixel_limit_is_enforced_before_processing(self):
        with patch("processing.MAX_PIXELS", 100):
            with self.assertRaises(MediaError):
                inspect_media(self.source)
            with self.assertRaises(MediaError):
                remove_white(self.source, self.output, {}, quiet)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class GifTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.source = cls.root / "motion.mp4"
        run([tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
             "testsrc2=size=640x360:rate=24:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.source)])

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_gif_adapts_below_budget_without_shortening_clip(self):
        output = self.root / "adaptive.gif"
        result = make_gif(self.source, output, {"start": 0.5, "duration": 3, "width": 640, "fps": 24, "max_kb": 100}, quiet)
        self.assertLess(output.stat().st_size, 100_000)
        self.assertGreater(result["attempts"], 1)
        self.assertAlmostEqual(result["duration"], 3, delta=0.2)
        with Image.open(output) as image:
            self.assertEqual(image.info["loop"], 0)
            self.assertGreater(image.n_frames, 1)
        print(f"\nAdaptive GIF: {output.stat().st_size:,} bytes, {result}")

    def test_portrait_uses_longest_edge_and_end_of_clip_is_clamped(self):
        portrait = self.root / "portrait.mp4"
        run([tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
             "testsrc2=size=180x320:rate=12:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(portrait)])
        result = make_gif(portrait, self.root / "portrait.gif", {"start": 1, "duration": 3, "width": 240}, quiet)
        self.assertLessEqual(max(result["width"], result["height"]), 240)
        self.assertAlmostEqual(result["width"] / result["height"], 180 / 320, delta=0.02)
        self.assertAlmostEqual(result["duration"], 1, delta=0.2)

    def test_invalid_time_and_budget_are_rejected(self):
        for options in [{"start": 50}, {"duration": 16}, {"max_kb": 501}, {"fps": "x"}]:
            with self.assertRaises(MediaError):
                make_gif(self.source, self.root / "bad.gif", options, quiet)


if __name__ == "__main__":
    unittest.main(verbosity=2)
