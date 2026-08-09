"""Panorama detection and stitching.

Self-contained classical-CV implementation (ORB + RANSAC homography, cv2 Stitcher).
Exposed through dedicated endpoints in main.py (the /predict pipeline is single-image).
All functions here are synchronous and CPU-bound; callers run them in the thread pool.
"""

from typing import Any, Literal, TypedDict, cast

import cv2
import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, Field

from immich_ml.config import log


class PanoramaError(Exception):
    """Raised for invalid input or an impossible stitch; carries an HTTP status."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class DetectOptions(BaseModel):
    minMatches: int = Field(default=20, ge=4)
    minInliers: int = Field(default=22, ge=4)
    minInlierRatio: float = Field(default=0.18, ge=0.0, le=1.0)
    minOverlap: float = Field(default=0.10, ge=0.0, le=1.0)
    maxOverlap: float = Field(default=0.85, ge=0.0, le=1.0)
    minDisplacement: float = Field(default=0.12, ge=0.0, le=1.0)
    maxScaleDrift: float = Field(default=0.08, ge=0.0, le=1.0)
    maxDim: int = Field(default=1000, ge=256, le=2048)
    orbFeatures: int = Field(default=2500, ge=500, le=8000)


class StitchOptions(BaseModel):
    quality: int = Field(default=97, ge=50, le=100)
    compositeResolution: Literal["full", "preview"] = "full"
    cropAuto: bool = True
    maxMegapixels: float = Field(default=400.0, gt=0.0, le=1000.0)
    verifySources: bool = True


MAX_FRAMES = 32
PREVIEW_MAX_DIM = 1440


class LinkStats(TypedDict):
    matches: int
    inliers: int
    ratio: float
    overlap: float | None
    displacement: float | None
    dx: float
    dy: float
    scale: float
    ok: bool


class DetectResult(TypedDict):
    frames: int
    links: list[LinkStats]
    classification: Literal["panorama", "burst", "unrelated"]
    chainStart: int | None
    chainEnd: int | None
    score: float
    mixedDirections: bool
    scaleDrift: float


def _decode(image: bytes, grayscale: bool = False) -> NDArray[np.uint8]:
    flags = cv2.IMREAD_GRAYSCALE if grayscale else cv2.IMREAD_COLOR
    mat = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), flags)
    if mat is None:
        mat = _decode_raw(image, grayscale)
    if mat is None:
        raise PanoramaError(400, "Failed to decode an input image")
    return cast(NDArray[np.uint8], mat)


def _decode_raw(image: bytes, grayscale: bool) -> NDArray[np.uint8] | None:
    """Develop camera RAW bytes (DNG etc.) that cv2 cannot decode."""
    import io

    try:
        import rawpy

        with rawpy.imread(io.BytesIO(image)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
    except Exception:
        return None
    mat = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY if grayscale else cv2.COLOR_RGB2BGR)
    return cast(NDArray[np.uint8], mat)


def _downscale(img: NDArray[np.uint8], max_dim: int) -> NDArray[np.uint8]:
    h, w = img.shape[:2]
    scale = max_dim / max(h, w)
    if scale >= 1.0:
        return img
    return cast(NDArray[np.uint8], cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA))


def _empty_link() -> LinkStats:
    return LinkStats(
        matches=0, inliers=0, ratio=0.0, overlap=None, displacement=None, dx=0.0, dy=0.0, scale=1.0, ok=False
    )


def _eval_pair(
    kp_a: Any,
    des_a: Any,
    shape_a: tuple[int, int],
    kp_b: Any,
    des_b: Any,
    shape_b: tuple[int, int],
    options: DetectOptions,
) -> LinkStats:
    link = _empty_link()
    if des_a is None or des_b is None or len(kp_a) < 40 or len(kp_b) < 40:
        return link
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    knn = matcher.knnMatch(des_a, des_b, k=2)
    good = [m for m, n in (pair for pair in knn if len(pair) == 2) if m.distance < 0.75 * n.distance]
    link["matches"] = len(good)
    if len(good) < options.minMatches:
        return link
    src = np.array([kp_a[m.queryIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
    dst = np.array([kp_b[m.trainIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
    homography, mask = cv2.findHomography(dst, src, cv2.RANSAC, 4.0)  # maps b -> a
    if homography is None:
        return link
    inliers = int(mask.sum())
    link["inliers"] = inliers
    link["ratio"] = round(inliers / len(good), 3)
    if inliers < options.minInliers or link["ratio"] < options.minInlierRatio:
        return link
    det = homography[0, 0] * homography[1, 1] - homography[0, 1] * homography[1, 0]
    if not (0.15 < abs(det) < 6.0) or abs(homography[2, 0]) > 0.003 or abs(homography[2, 1]) > 0.003:
        return link
    link["scale"] = round(float(abs(det)) ** 0.5, 3)
    height_a, width_a = shape_a
    height_b, width_b = shape_b
    corners_b = np.array([[0, 0], [width_b, 0], [width_b, height_b], [0, height_b]], dtype=np.float32).reshape(-1, 1, 2)
    warped = cv2.perspectiveTransform(corners_b, homography).reshape(-1, 2).astype(np.float32)
    if not cv2.isContourConvex(warped):
        return link
    rect_a = np.array([[0, 0], [width_a, 0], [width_a, height_a], [0, height_a]], dtype=np.float32)
    intersection, _ = cv2.intersectConvexConvex(rect_a, warped)
    area_a = float(width_a * height_a)
    area_b = float(abs(cv2.contourArea(warped)))
    if area_b <= 0:
        return link
    link["overlap"] = round(float(intersection) / min(area_a, area_b), 3)
    center_shift = warped.mean(axis=0) - np.array([width_a / 2, height_a / 2])
    link["dx"] = round(float(center_shift[0]), 1)
    link["dy"] = round(float(center_shift[1]), 1)
    link["displacement"] = round(float(np.hypot(*center_shift)) / max(width_a, height_a), 3)
    link["ok"] = True
    return link


def _is_pano_link(link: LinkStats, options: DetectOptions, strict: bool = False) -> bool:
    if not link["ok"] or link["overlap"] is None or link["displacement"] is None:
        return False
    lo, hi = options.minOverlap, options.maxOverlap
    min_inliers = options.minInliers
    if strict:
        lo, hi = max(lo, 0.15), min(hi, 0.75)
        min_inliers = max(min_inliers, 35)
    return (
        lo <= link["overlap"] <= hi
        and link["displacement"] >= options.minDisplacement
        and link["inliers"] >= min_inliers
    )


def _is_duplicate_link(link: LinkStats) -> bool:
    if not link["ok"] or link["overlap"] is None or link["displacement"] is None:
        return False
    return link["overlap"] > 0.85 or (link["overlap"] > 0.7 and link["displacement"] < 0.08)


def detect(images: list[bytes], options: DetectOptions) -> DetectResult:
    if not 2 <= len(images) <= MAX_FRAMES:
        raise PanoramaError(400, f"Panorama detection needs 2..{MAX_FRAMES} images, got {len(images)}")
    orb = cv2.ORB.create(nfeatures=options.orbFeatures, scaleFactor=1.2, nlevels=8)
    grays = [_downscale(_decode(image, grayscale=True), options.maxDim) for image in images]
    features = [orb.detectAndCompute(gray, None) for gray in grays]

    links: list[LinkStats] = []
    for i in range(len(images) - 1):
        (kp_a, des_a), (kp_b, des_b) = features[i], features[i + 1]
        links.append(_eval_pair(kp_a, des_a, grays[i].shape[:2], kp_b, des_b, grays[i + 1].shape[:2], options))

    best_start = best_end = -1
    run_start: int | None = None
    for i, link in enumerate(links):
        if _is_pano_link(link, options):
            if run_start is None:
                run_start = i
            if best_start < 0 or i - run_start > best_end - best_start:
                best_start, best_end = run_start, i
        else:
            run_start = None

    classification: Literal["panorama", "burst", "unrelated"] = "unrelated"
    chain_start: int | None = None
    chain_end: int | None = None
    score = 0.0
    mixed = False
    scale_drift = 0.0
    if best_start >= 0:
        chain_links = links[best_start : best_end + 1]
        frame_count = best_end - best_start + 2
        scale_drift = round(float(np.median([abs(link["scale"] - 1) for link in chain_links])), 3)
        if scale_drift > options.maxScaleDrift:
            # Consistent zoom between frames means the camera moved forward (walking,
            # driving) rather than sweeping — stitching these produces garbage.
            log.debug(f"Rejecting chain of {frame_count} frames: scale drift {scale_drift}")
        elif frame_count > 2 or _is_pano_link(chain_links[0], options, strict=True):
            classification = "panorama"
            chain_start, chain_end = best_start, best_end + 1
            ideal = [1 - abs((link["overlap"] or 0) - 0.4) / 0.45 for link in chain_links]
            score = frame_count * 2 + sum(min(link["inliers"], 200) / 200 for link in chain_links) + sum(ideal)
            xs = {np.sign(link["dx"]) for link in chain_links if abs(link["dx"]) > abs(link["dy"])}
            ys = {np.sign(link["dy"]) for link in chain_links if abs(link["dy"]) >= abs(link["dx"])}
            mixed = len(xs) > 1 or len(ys) > 1
            if mixed:
                score *= 0.7
    if classification == "unrelated" and links:
        duplicates = sum(1 for link in links if _is_duplicate_link(link))
        if duplicates >= max(1, len(links) // 2):
            classification = "burst"

    return DetectResult(
        frames=len(images),
        links=links,
        classification=classification,
        chainStart=chain_start,
        chainEnd=chain_end,
        score=round(score, 2),
        mixedDirections=mixed,
        scaleDrift=scale_drift,
    )


def _autocrop(pano: NDArray[np.uint8]) -> NDArray[np.uint8]:
    """Trim the black canvas border left by warping, keeping a fully-filled interior."""
    gray = cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY)
    mask = (gray > 0).astype(np.uint8)
    col_fill = mask.mean(axis=0)
    row_fill = mask.mean(axis=1)
    xs = np.where(col_fill > 0.60)[0]
    ys = np.where(row_fill > 0.60)[0]
    if len(xs) < 50 or len(ys) < 50:
        return pano
    x0, x1, y0, y1 = int(xs[0]), int(xs[-1]), int(ys[0]), int(ys[-1])
    sub = mask[y0 : y1 + 1, x0 : x1 + 1]
    for _ in range(4000):
        h, w = sub.shape
        if h < 100 or w < 100:
            break
        edges = {"top": sub[0].mean(), "bottom": sub[-1].mean(), "left": sub[:, 0].mean(), "right": sub[:, -1].mean()}
        worst = min(edges, key=lambda k: edges[k])
        if edges[worst] >= 0.995:
            break
        if worst == "top":
            y0 += 1
            sub = sub[1:]
        elif worst == "bottom":
            y1 -= 1
            sub = sub[:-1]
        elif worst == "left":
            x0 += 1
            sub = sub[:, 1:]
        else:
            x1 -= 1
            sub = sub[:, :-1]
    return pano[y0 : y1 + 1, x0 : x1 + 1]


def _verify_sources(frames: list[NDArray[np.uint8]], pano: NDArray[np.uint8]) -> list[int]:
    """Indices of feature-rich source frames that cannot be re-localized inside the result.

    A structurally wrong merge can look plausible while having dropped, duplicated, or
    misplaced content; requiring every source frame to match consistently into the pano
    catches that. Low-texture frames (sky, plain walls) are skipped — too few features
    to judge either way.
    """
    # size the proxy so each frame still spans a few hundred pixels in a long panorama
    verify_dim = min(8000, int(2600 * max(1.0, (len(frames) / 8) ** 0.5)))
    pano_gray = _downscale(cast(NDArray[np.uint8], cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY)), verify_dim)
    orb_pano = cv2.ORB.create(nfeatures=2000 + 1000 * len(frames))
    orb_frame = cv2.ORB.create(nfeatures=1500)
    pano_kp, pano_des = orb_pano.detectAndCompute(pano_gray, None)
    if pano_des is None:
        return []
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    missing: list[int] = []
    for index, frame in enumerate(frames):
        gray = _downscale(cast(NDArray[np.uint8], cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)), 900)
        kp, des = orb_frame.detectAndCompute(gray, None)
        if des is None or len(kp) < 300:
            continue  # not enough texture to judge
        knn = matcher.knnMatch(des, pano_des, k=2)
        good = [m for m, n in (pair for pair in knn if len(pair) == 2) if m.distance < 0.75 * n.distance]
        inliers = 0
        if len(good) >= 12:
            src = np.array([kp[m.queryIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
            dst = np.array([pano_kp[m.trainIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
            homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
            if homography is not None:
                inliers = int(mask.sum())
        if inliers < 20:
            missing.append(index)
    return missing


def stitch(images: list[bytes], options: StitchOptions) -> tuple[bytes, int, int]:
    """Stitch ordered frames into a panorama. Returns (jpeg bytes, width, height)."""
    if not 2 <= len(images) <= MAX_FRAMES:
        raise PanoramaError(400, f"Panorama stitching needs 2..{MAX_FRAMES} images, got {len(images)}")
    frames = [_decode(image) for image in images]
    if options.compositeResolution == "preview":
        frames = [_downscale(frame, PREVIEW_MAX_DIM) for frame in frames]
    # long chains inflate warp/blend buffers beyond what total input megapixels predict;
    # tighten the budget as frame count grows (measured: 13 frames at 400MP fits 6GB)
    budget = (
        min(options.maxMegapixels, options.maxMegapixels * 13.0 / len(frames))
        if len(frames) > 13
        else options.maxMegapixels
    )
    total_megapixels = sum(frame.shape[0] * frame.shape[1] for frame in frames) / 1e6
    if total_megapixels > budget:
        # Scale all frames proportionally to fit the memory budget instead of failing —
        # e.g. ten 50MP frames come down to ~40MP each rather than erroring out.
        scale = (budget / total_megapixels) ** 0.5
        frames = [
            cast(
                NDArray[np.uint8],
                cv2.resize(
                    frame,
                    (max(1, int(frame.shape[1] * scale)), max(1, int(frame.shape[0] * scale))),
                    interpolation=cv2.INTER_AREA,
                ),
            )
            for frame in frames
        ]
        log.info(f"Panorama input of {total_megapixels:.0f}MP exceeds {budget:.0f}MP budget, scaling by {scale:.2f}")

    def try_stitch(mode: int, confidence: float) -> tuple[int, NDArray[np.uint8] | None]:
        stitcher = cv2.Stitcher.create(mode)
        stitcher.setPanoConfidenceThresh(confidence)
        try:
            status, pano = stitcher.stitch(frames)
            return int(status), cast(NDArray[np.uint8] | None, pano)
        except cv2.error as error:
            # a divergent registration can blow past cv2's 32767px remap limit;
            # treat it as a failed attempt rather than crashing the request
            log.warning(f"Stitch attempt raised: {str(error).splitlines()[-1][:120]}")
            return int(cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL), None

    status, pano = try_stitch(cv2.Stitcher_PANORAMA, 0.6)
    if status != cv2.Stitcher_OK:
        status, pano = try_stitch(cv2.Stitcher_PANORAMA, 0.4)
    if status != cv2.Stitcher_OK:
        # flat subjects photographed close up (documents, boards) violate the rotational
        # model but stitch cleanly with the affine SCANS pipeline
        status, pano = try_stitch(cv2.Stitcher_SCANS, 0.5)
    if status != cv2.Stitcher_OK or pano is None:
        reasons = {
            cv2.Stitcher_ERR_NEED_MORE_IMGS: "not enough overlapping content",
            cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL: "homography estimation failed",
            cv2.Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL: "camera parameter adjustment failed",
        }
        raise PanoramaError(422, f"Stitch failed: {reasons.get(status, f'status {status}')}")
    if options.cropAuto:
        pano = _autocrop(pano)

    # A structurally broken registration can still return Stitcher_OK, either by
    # collapsing the scene into a smear far smaller than any input frame, or by
    # scattering fragments across a huge mostly-black canvas.
    median_frame_area = float(np.median([frame.shape[0] * frame.shape[1] for frame in frames]))
    if pano.shape[0] * pano.shape[1] < 0.5 * median_frame_area:
        raise PanoramaError(422, "Stitch failed: degenerate result (registration collapsed the scene)")
    filled = float((cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY) > 8).mean())
    if filled < 0.85:
        raise PanoramaError(422, f"Stitch failed: degenerate result (canvas only {filled:.0%} filled)")
    if options.verifySources:
        missing = _verify_sources(frames, pano)
        if missing and len(frames) - len(missing) < max(2, len(frames) // 2):
            raise PanoramaError(422, f"Stitch failed verification: source frame(s) {missing} not found in the result")
        if missing:
            # the stitcher pruned some frames but the majority composed correctly —
            # deliver the partial panorama rather than nothing
            log.warning(f"Partial panorama: {len(missing)} of {len(frames)} frames not in the result ({missing})")

    params = [cv2.IMWRITE_JPEG_QUALITY, options.quality, cv2.IMWRITE_JPEG_OPTIMIZE, 1]
    if options.quality >= 95 and hasattr(cv2, "IMWRITE_JPEG_SAMPLING_FACTOR"):
        params += [cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444]
    ok, encoded = cv2.imencode(".jpg", pano, params)
    if not ok:
        raise PanoramaError(500, "Failed to encode stitched panorama")
    height, width = pano.shape[:2]
    log.info(f"Stitched {len(images)} frames into {width}x{height} panorama ({width * height / 1e6:.1f}MP)")
    return encoded.tobytes(), width, height
