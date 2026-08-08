import cv2
import numpy as np
import pytest

from immich_ml.panorama import DetectOptions, PanoramaError, StitchOptions, detect, stitch


def _textured_scene(width: int = 1600, height: int = 900, seed: int = 42) -> np.ndarray:
    """A synthetic scene with enough structure for ORB features."""
    rng = np.random.default_rng(seed)
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = np.linspace(40, 200, width, dtype=np.uint8)[None, :, None]
    for _ in range(400):
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        r = int(rng.integers(4, 28))
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        cv2.circle(img, (x, y), r, color, -1)
    noise = rng.integers(0, 25, (height, width, 3), dtype=np.uint8)
    return cv2.add(img, noise)


def _strips(img: np.ndarray, count: int = 3, strip_frac: float = 0.45) -> list[bytes]:
    """Overlapping vertical strips simulating a left-to-right sweep."""
    height, width = img.shape[:2]
    strip_w = int(width * strip_frac)
    step = (width - strip_w) // (count - 1)
    out = []
    for i in range(count):
        x0 = i * step
        ok, buf = cv2.imencode(".png", img[:, x0 : x0 + strip_w])
        assert ok
        out.append(buf.tobytes())
    return out


def _encode(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


class TestPanoramaDetect:
    def test_sweep_is_classified_panorama(self) -> None:
        result = detect(_strips(_textured_scene()), DetectOptions())
        assert result["classification"] == "panorama"
        assert result["chainStart"] == 0
        assert result["chainEnd"] == 2
        assert result["score"] > 5
        assert all(link["ok"] for link in result["links"])
        for link in result["links"]:
            assert link["overlap"] is not None and 0.2 < link["overlap"] < 0.6

    def test_identical_frames_are_burst(self) -> None:
        frame = _encode(_textured_scene())
        result = detect([frame, frame, frame], DetectOptions())
        assert result["classification"] == "burst"

    def test_unrelated_frames_are_unrelated(self) -> None:
        a = _encode(_textured_scene(seed=1))
        b = _encode(_textured_scene(seed=2))
        result = detect([a, b], DetectOptions())
        assert result["classification"] == "unrelated"

    def test_two_frame_pair_uses_strict_thresholds(self) -> None:
        # 60%-width strips of the same scene -> ~33% overlap, valid 2-frame pano
        result = detect(_strips(_textured_scene(), count=2, strip_frac=0.6), DetectOptions())
        assert result["classification"] == "panorama"

    def test_frame_count_limits(self) -> None:
        frame = _encode(_textured_scene())
        with pytest.raises(PanoramaError) as err:
            detect([frame], DetectOptions())
        assert err.value.status_code == 400
        with pytest.raises(PanoramaError):
            detect([frame] * 17, DetectOptions())

    def test_invalid_image_bytes(self) -> None:
        with pytest.raises(PanoramaError) as err:
            detect([b"not an image", b"also not"], DetectOptions())
        assert err.value.status_code == 400


class TestPanoramaStitch:
    def test_sweep_stitches_back_to_scene(self) -> None:
        scene = _textured_scene()
        jpeg, width, height = stitch(_strips(scene), StitchOptions())
        assert width == pytest.approx(scene.shape[1], rel=0.05)
        assert height == pytest.approx(scene.shape[0], rel=0.05)
        decoded = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        assert decoded is not None and decoded.shape[1] == width

    def test_preview_resolution_downscales(self) -> None:
        _, width, height = stitch(_strips(_textured_scene()), StitchOptions(compositeResolution="preview"))
        assert max(width, height) <= 1440 * 2.5  # panorama is wider than one frame, but bounded

    def test_unstitchable_input_raises_422(self) -> None:
        # pure noise: plenty of features, no consistent geometry between frames
        rng_a, rng_b = np.random.default_rng(10), np.random.default_rng(11)
        a = _encode(rng_a.integers(0, 255, (600, 800, 3), dtype=np.uint8))
        b = _encode(rng_b.integers(0, 255, (600, 800, 3), dtype=np.uint8))
        with pytest.raises(PanoramaError) as err:
            stitch([a, b], StitchOptions())
        assert err.value.status_code == 422

    def test_megapixel_cap(self) -> None:
        with pytest.raises(PanoramaError) as err:
            stitch(_strips(_textured_scene()), StitchOptions(maxMegapixels=0.5))
        assert err.value.status_code == 413

    def test_quality_affects_size(self) -> None:
        strips = _strips(_textured_scene())
        hi, _, _ = stitch(strips, StitchOptions(quality=97))
        lo, _, _ = stitch(strips, StitchOptions(quality=60))
        assert len(hi) > len(lo)
