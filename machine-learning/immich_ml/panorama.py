"""Panorama detection and stitching.

Self-contained classical-CV implementation (ORB + RANSAC homography, cv2 Stitcher).
Exposed through dedicated endpoints in main.py (the /predict pipeline is single-image).
All functions here are synchronous and CPU-bound; callers run them in the thread pool.
"""

import json
import os
import subprocess
import sys
import tempfile
from typing import Any, Literal, TypedDict, cast

import cv2
import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, Field

from immich_ml.config import log, settings


class PanoramaError(Exception):
    """Raised for invalid input or an impossible stitch; carries an HTTP status."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    def __reduce__(self) -> tuple[Any, tuple[int, str]]:
        # default Exception pickling replays only super().__init__(message); both args are needed
        # for the error to survive the trip back from the stitch subprocess
        return (PanoramaError, (self.status_code, self.message))


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
    sphericalFallback: bool = True
    threads: int = Field(default=0, ge=0, le=64)  # cv2 worker threads for stitching; 0 = library default


MAX_FRAMES = 32
PREVIEW_MAX_DIM = 1440
SPHERICAL_REGISTER_DIM = 1600  # feature/registration resolution for the spherical fallback
SPHERICAL_RANGE_WIDTH = 5  # match each frame to +/- this many ordered neighbours
STITCH_TIMEOUT_S = 780  # hard cap on the isolated stitch subprocess (the server aborts at 840s)
SPHERICAL_MAX_CANVAS_MP = 32.0  # compose-time canvas area budget (blender pyramids scale with it)
SEAM_WORK_MP = 0.1  # per-frame resolution for graph-cut seam estimation (canonical two-scale seams)
SPHERICAL_FIRST_FRAMES = 14  # chains this long are rotational sweeps; try the spherical pipeline first

# (jpeg bytes, width, height, quality metrics)
StitchOutput = tuple[bytes, int, int, dict[str, Any]]


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


def _encode_pano(pano: NDArray[np.uint8], quality: int) -> tuple[bytes, int, int]:
    params = [cv2.IMWRITE_JPEG_QUALITY, quality, cv2.IMWRITE_JPEG_OPTIMIZE, 1]
    if quality >= 95 and hasattr(cv2, "IMWRITE_JPEG_SAMPLING_FACTOR"):
        params += [cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444]
    ok, encoded = cv2.imencode(".jpg", pano, params)
    if not ok:
        raise PanoramaError(500, "Failed to encode stitched panorama")
    height, width = pano.shape[:2]
    return encoded.tobytes(), width, height


def _overlap_metrics(
    image_a: Any, mask_a: Any, corner_a: Any, image_b: Any, mask_b: Any, corner_b: Any
) -> tuple[float, float] | None:
    """Ghosting/exposure agreement of two warped neighbours over their overlap: mean |a-b| and the
    signed brightness residual, both in grayscale levels. None when the overlap is too small."""
    ax, ay = corner_a
    bx, by = corner_b
    x0 = max(ax, bx)
    y0 = max(ay, by)
    x1 = min(ax + image_a.shape[1], bx + image_b.shape[1])
    y1 = min(ay + image_a.shape[0], by + image_b.shape[0])
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    patch_a = image_a[y0 - ay : y1 - ay, x0 - ax : x1 - ax]
    patch_b = image_b[y0 - by : y1 - by, x0 - bx : x1 - bx]
    both = cv2.bitwise_and(mask_a[y0 - ay : y1 - ay, x0 - ax : x1 - ax], mask_b[y0 - by : y1 - by, x0 - bx : x1 - bx])
    if int(cv2.countNonZero(both)) < 200:
        return None
    gray_a = cv2.cvtColor(patch_a, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray_b = cv2.cvtColor(patch_b, cv2.COLOR_BGR2GRAY).astype(np.float32)
    selection = both > 0
    difference = gray_a[selection] - gray_b[selection]
    return float(np.abs(difference).mean()), float(difference.mean())


def _stitch_spherical(frames: list[NDArray[np.uint8]], options: StitchOptions) -> StitchOutput | None:
    """Hugin-class spherical fallback for wide/360 rotational sweeps the high-level cv2.Stitcher
    cannot register (it fails camera-parameter adjustment). Pipeline: ORB features -> ordered range
    matcher -> ray bundle adjustment -> horizontal wave correction -> spherical warp -> gain
    compensation -> Voronoi seams -> multi-band blend. Registration runs at SPHERICAL_REGISTER_DIM;
    the warp/blend composite is capped by frame count so a wide canvas stays tractable. Returns the
    encoded (jpeg, w, h), or None when registration collapses (caller then raises 422).

    Runs inline (the whole stitch already executes in an isolated subprocess); any opencv failure on
    degenerate input is treated as an incoherent sweep -> None, and only PanoramaError (a validated
    but unusable result) propagates."""
    try:
        return _stitch_spherical_impl(frames, options)
    except cv2.error as error:
        log.info(f"Spherical stitch: opencv registration failed ({str(error).splitlines()[-1][:100]}); no sweep")
        return None


def _stitch_spherical_impl(frames: list[NDArray[np.uint8]], options: StitchOptions) -> StitchOutput | None:
    # cv2's `detail_*` classes and PyRotationWarper are absent from the opencv type stubs; route
    # them through an Any alias so the stub gaps don't fail mypy (matching this module's loose-cv2 style).
    cv2_: Any = cv2
    n = len(frames)
    reg = [_downscale(f, SPHERICAL_REGISTER_DIM) for f in frames]
    # SIFT registers noticeably stronger pairwise chains than ORB on misty/low-texture sweeps and
    # the cost is bounded by the registration resolution
    finder = cv2.SIFT.create()
    features = [cv2.detail.computeImageFeatures2(finder, im) for im in reg]

    def _match(feats: list[Any]) -> Any:
        # ordered range matcher: only compare each frame to +/- SPHERICAL_RANGE_WIDTH neighbours.
        # Full O(n^2) matching injects spurious long-range pairs that make ray bundle adjustment
        # diverge on long chains; the sequential graph converges reliably.
        matcher = cv2_.detail_BestOf2NearestRangeMatcher(SPHERICAL_RANGE_WIDTH, False, 0.3)
        pairwise = matcher.apply2(feats)
        matcher.collectGarbage()
        return pairwise

    log.debug(f"Spherical: features computed for {len(reg)} frames")
    matches = _match(features)
    keep = [int(i) for i in np.asarray(cv2.detail.leaveBiggestComponent(features, matches, 0.3)).flatten()]
    if len(keep) < 3:
        log.info(f"Spherical stitch: only {len(keep)} of {n} frames connected; not a coherent sweep")
        return None
    frames = [frames[i] for i in keep]
    reg = [reg[i] for i in keep]
    features = [features[i] for i in keep]
    matches = _match(features)

    def _bundle_adjust(conf_thresh: float) -> Any:
        # fresh estimator state per attempt: bundle adjustment mutates the cameras in place
        ok, cams = cv2_.detail_HomographyBasedEstimator().apply(features, matches, None)
        if not ok:
            return None
        for cam in cams:
            cam.R = cam.R.astype(np.float32)
        adjuster = cv2_.detail_BundleAdjusterRay()
        adjuster.setConfThresh(conf_thresh)
        refine = np.zeros((3, 3), np.uint8)  # standard 5-param mask (fx, skew, ppx, aspect, ppy)
        refine[0, 0] = refine[0, 1] = refine[0, 2] = refine[1, 1] = refine[1, 2] = 1
        adjuster.setRefinementMask(refine)
        ok, cams = adjuster.apply(features, matches, cams)
        return cams if ok else None

    # 0.3 keeps too-weak pairs and diverges. Long chains converge most reliably on the
    # strongest-pairs graph (conf 1.0), so try that first for them; short chains keep the usual
    # 0.5 floor first. The other threshold remains as the retry.
    ladder = (1.0, 0.5) if n >= SPHERICAL_FIRST_FRAMES else (0.5, 1.0)
    cameras = _bundle_adjust(ladder[0])
    if cameras is None:
        log.info(f"Spherical stitch: bundle adjustment at conf {ladder[0]} did not converge; retrying at {ladder[1]}")
        cameras = _bundle_adjust(ladder[1])
    if cameras is None:
        log.info("Spherical stitch: bundle adjustment did not converge")
        return None

    rmats: list[Any] = [np.copy(cam.R) for cam in cameras]
    rmats = list(cv2.detail.waveCorrect(rmats, cv2.detail.WAVE_CORRECT_HORIZ))  # level a hand-held arc
    for i, cam in enumerate(cameras):
        cam.R = rmats[i]
    warped_scale = float(np.median(sorted(cam.focal for cam in cameras)))

    kept = len(reg)
    # True two-scale compose: the camera model was estimated in registration-pixel units, but the
    # composite warps the full budget-capped frames — frame_scale lifts K and the warp radius to
    # full-frame units so output resolution is governed by the megapixel budget, not the
    # registration size. The canvas area budget rides the admin maxMegapixels setting.
    frame_scale = max(frames[0].shape[:2]) / max(reg[0].shape[:2])
    canvas_budget_mp = min(128.0, max(16.0, options.maxMegapixels / 4.0))
    if options.compositeResolution == "preview":
        canvas_budget_mp = min(canvas_budget_mp, 8.0)

    # Probe the projected footprint before allocating anything: a drifted registration can imply a
    # canvas of hundreds of megapixels, and the multi-band blender allocates pyramids across all of
    # it — enough to breach the container memory limit. Clamp the compose scale to the area budget.
    probe = cv2_.PyRotationWarper("spherical", warped_scale * frame_scale)
    x0 = y0 = np.inf
    x1 = y1 = -np.inf
    for i, im in enumerate(frames):
        K = cameras[i].K().astype(np.float32)
        K[:2, :] *= frame_scale
        rx, ry, rw, rh = probe.warpRoi((im.shape[1], im.shape[0]), K, cameras[i].R)
        x0, y0 = min(x0, rx), min(y0, ry)
        x1, y1 = max(x1, rx + rw), max(y1, ry + rh)
    full_canvas_mp = max(1.0, (x1 - x0) * (y1 - y0) / 1e6)
    compose_factor = min(1.0, (canvas_budget_mp / full_canvas_mp) ** 0.5)

    canvas_estimate = full_canvas_mp * compose_factor**2
    log.debug(f"Spherical: compose factor {compose_factor:.2f} of full frames (canvas est {canvas_estimate:.0f}MP)")
    warper = cv2_.PyRotationWarper("spherical", warped_scale * frame_scale * compose_factor)

    # Pass 1 — compose-scale geometry only (warpRoi allocates nothing): per-frame degeneracy guard,
    # the real canvas check, and the corner/size lists the blender needs up front.
    corners: list[Any] = []
    sizes: list[tuple[int, int]] = []
    compose_ks: list[Any] = []
    for i, im in enumerate(frames):
        K = cameras[i].K().astype(np.float32)
        K[:2, :] *= frame_scale * compose_factor
        compose_ks.append(K)
        expect_w = max(1, int(im.shape[1] * compose_factor))
        expect_h = max(1, int(im.shape[0] * compose_factor))
        roi = warper.warpRoi((expect_w, expect_h), K, cameras[i].R)
        if roi[2] * roi[3] > 16 * expect_w * expect_h:
            # a near-pole or wrapped frame can explode to an absurd warped extent; treat the
            # registration as degenerate rather than allocating it
            log.info(f"Spherical stitch: frame {i} warps to {roi[2]}x{roi[3]}; registration degenerate")
            return None
        corners.append((roi[0], roi[1]))
        sizes.append((roi[2], roi[3]))
    dst_sz = cv2.detail.resultRoi(corners, sizes)
    actual_canvas_mp = dst_sz[2] * dst_sz[3] / 1e6
    if actual_canvas_mp > 1.5 * canvas_budget_mp:
        # warpRoi estimates can diverge from the union on wrap-around registrations (observed as a
        # 33GB allocation pre-guard); bind the real canvas, not the prediction
        log.info(f"Spherical stitch: actual canvas {actual_canvas_mp:.0f}MP breaches budget; registration degenerate")
        return None

    # Pass 2 — seam-scale everything (canonical two-scale): warp small copies, feed the exposure
    # compensator and graph-cut seams entirely at ~SEAM_WORK_MP per frame. Cheap and tiny.
    seam_factor = min(1.0, (SEAM_WORK_MP * 1e6 / max(sizes[0][0] * sizes[0][1], 1)) ** 0.5)
    seam_warper = cv2_.PyRotationWarper("spherical", warped_scale * frame_scale * compose_factor * seam_factor)
    seam_images: list[Any] = []
    seam_masks: list[Any] = []
    seam_corners: list[Any] = []
    for i, im in enumerate(frames):
        f = compose_factor * seam_factor
        small = cv2.resize(im, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        K = cameras[i].K().astype(np.float32)
        K[:2, :] *= frame_scale * compose_factor * seam_factor
        corner, img_wp = seam_warper.warp(small, K, cameras[i].R, cv2.INTER_LINEAR, cv2.BORDER_REFLECT)
        _, mask_wp = seam_warper.warp(
            255 * np.ones(small.shape[:2], np.uint8), K, cameras[i].R, cv2.INTER_NEAREST, cv2.BORDER_CONSTANT
        )
        seam_corners.append(corner)
        seam_images.append(img_wp)
        seam_masks.append(mask_wp)

    # per-channel block gains: phone sweeps change exposure AND white balance frame to frame; a
    # single luminance gain leaves visible colour steps at seams. Gain maps learned at seam scale
    # apply cleanly at compose scale (they are relative).
    compensator = cv2_.detail_BlocksChannelsCompensator()
    compensator.feed(seam_corners, seam_images, seam_masks)
    # Quality metrics on the compensated seam-scale frames (all co-resident, nearly free):
    # ghosting = mean |a-b| over each consecutive overlap — misregistration and parallax show up
    # here; exposure residual = the signed brightness step compensation failed to remove.
    for i in range(kept):
        compensator.apply(i, seam_corners[i], seam_images[i], seam_masks[i])
    overlap_errors: list[float] = []
    exposure_residuals: list[float] = []
    for i in range(kept - 1):
        pair = _overlap_metrics(
            seam_images[i], seam_masks[i], seam_corners[i],
            seam_images[i + 1], seam_masks[i + 1], seam_corners[i + 1],
        )
        if pair is not None:
            overlap_errors.append(pair[0])
            exposure_residuals.append(pair[1])
    seam_finder = cv2_.detail_GraphCutSeamFinder("COST_COLOR")
    found = seam_finder.find([img.astype(np.float32) for img in seam_images], seam_corners, seam_masks)
    seam_masks = [f.get() if isinstance(f, cv2.UMat) else f for f in found]
    seam_images = []  # only the seam masks are needed from here on

    # Pass 3 — compose: warp each full frame, compensate, blend, and free it before the next one;
    # peak memory is a single warped frame plus the blender pyramids.
    blender = cv2_.detail_MultiBandBlender()
    blend_width = float(np.sqrt(dst_sz[2] * dst_sz[3]) * 0.05)
    blender.setNumBands(max(1, int(np.log2(blend_width)) - 1) if blend_width > 1 else 1)
    blender.prepare(dst_sz)
    for i, im in enumerate(frames):
        if compose_factor < 1.0:
            im = cast(
                NDArray[np.uint8],
                cv2.resize(im, None, fx=compose_factor, fy=compose_factor, interpolation=cv2.INTER_AREA),
            )
        corner, img_wp = warper.warp(im, compose_ks[i], cameras[i].R, cv2.INTER_LINEAR, cv2.BORDER_REFLECT)
        _, mask_wp = warper.warp(
            255 * np.ones(im.shape[:2], np.uint8), compose_ks[i], cameras[i].R, cv2.INTER_NEAREST, cv2.BORDER_CONSTANT
        )
        compensator.apply(i, corner, img_wp, mask_wp)
        seam_full = cv2.resize(seam_masks[i], (img_wp.shape[1], img_wp.shape[0]), interpolation=cv2.INTER_NEAREST)
        seam_full = cv2.dilate(seam_full, np.ones((3, 3), np.uint8))
        seam_full = cv2.bitwise_and(seam_full, mask_wp)
        blender.feed(cv2_.UMat(img_wp.astype(np.int16)), seam_full, corner)
    result, _ = blender.blend(None, None)
    pano = cast(NDArray[np.uint8], cv2.convertScaleAbs(result))

    if options.cropAuto:
        pano = _autocrop(pano)

    # Spherical-specific guards: the planar degenerate/verify checks compare to full-res source
    # frames, but this canvas is intentionally down-composited, so gauge against the warped frame
    # size instead and require a wide, well-filled strip.
    compose_frame_area = float(np.median([w * h for (w, h) in sizes]))
    if pano.shape[0] < 64 or pano.shape[1] < 256 or pano.shape[0] * pano.shape[1] < 0.4 * compose_frame_area:
        raise PanoramaError(422, "Stitch failed: spherical registration collapsed the scene")
    filled = float((cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY) > 8).mean())
    if filled < 0.80:
        raise PanoramaError(422, f"Stitch failed: spherical result only {filled:.0%} filled")

    metrics = {
        "pipeline": "spherical",
        "framesKept": kept,
        "framesTotal": n,
        "fill": round(filled, 3),
        "overlapErrorMean": round(float(np.mean(overlap_errors)), 2) if overlap_errors else None,
        "overlapErrorMax": round(float(np.max(overlap_errors)), 2) if overlap_errors else None,
        "exposureResidualMean": round(float(np.mean(np.abs(exposure_residuals))), 2) if exposure_residuals else None,
    }
    log.info(f"Spherical fallback stitched {kept}/{n} frames into {pano.shape[1]}x{pano.shape[0]} ({metrics})")
    data, width, height = _encode_pano(pano, options.quality)
    return data, width, height, metrics


def stitch(images: list[bytes], options: StitchOptions) -> StitchOutput:
    """Stitch ordered frames into a panorama in an isolated subprocess. Returns (jpeg, width, height).

    The whole pipeline runs in a *spawned* child: stitching can segfault or OOM on pathological
    input (a divergent registration implies an arbitrarily large compose canvas), and running it
    in-process both risked the worker and left gigabytes of freed-but-retained heap behind after
    every job. A plain fork+exec subprocess (python -m immich_ml.stitch_cli) rather than
    multiprocessing: mp's fork start deadlocks under a threaded gunicorn parent (inherited locks)
    and its spawn bootstrap wedged the same way, whereas exec resets the child completely. The
    spool directory carries payloads in and the result out; the child's stderr is captured to a
    file so failures are always inspectable. Any crash or timeout surfaces as a clean 422."""
    with tempfile.TemporaryDirectory(prefix="immich-stitch-") as spool_dir:
        for index, image in enumerate(images):
            with open(os.path.join(spool_dir, f"{index:03}.bin"), "wb") as spool_file:
                spool_file.write(image)
        with open(os.path.join(spool_dir, "options.json"), "w") as options_file:
            options_file.write(options.model_dump_json())
        stderr_path = os.path.join(spool_dir, "stderr.log")
        with open(stderr_path, "wb") as stderr_file:
            proc = subprocess.Popen(
                [sys.executable, "-m", "immich_ml.stitch_cli", spool_dir],
                stdout=subprocess.DEVNULL,
                stderr=stderr_file,
                cwd="/",
            )
        timeout_s = settings.pano_stitch_timeout or STITCH_TIMEOUT_S
        try:
            exit_code = proc.wait(timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(10)
            log.warning(f"Stitch subprocess exceeded {timeout_s}s; killed. Last output:\n{_tail(stderr_path)}")
            raise PanoramaError(422, f"Stitch failed: exceeded the {timeout_s}s time budget") from None

        result_path = os.path.join(spool_dir, "result.json")
        if exit_code != 0 or not os.path.exists(result_path):
            log.warning(f"Stitch subprocess died (exit {exit_code}). Last output:\n{_tail(stderr_path)}")
            raise PanoramaError(422, "Stitch failed: worker crashed (likely out of memory; lower the megapixel budget)")
        with open(result_path) as result_file:
            result = json.load(result_file)
        if "status_code" in result:
            log.debug(f"Stitch subprocess reported {result['status_code']}. Stage trace:\n{_tail(stderr_path)}")
            raise PanoramaError(result["status_code"], result["message"])
        log.debug(f"Stitch subprocess trace:\n{_tail(stderr_path)}")
        with open(os.path.join(spool_dir, "result.bin"), "rb") as data_file:
            data = data_file.read()
        return data, int(result["width"]), int(result["height"]), result.get("metrics") or {}


def _tail(path: str, max_bytes: int = 2000) -> str:
    try:
        with open(path, "rb") as tail_file:
            tail_file.seek(0, os.SEEK_END)
            size = tail_file.tell()
            tail_file.seek(max(0, size - max_bytes))
            return tail_file.read().decode(errors="replace").strip()
    except OSError:
        return "(no output captured)"


def _stitch(paths: list[str], options: StitchOptions) -> StitchOutput:
    if not 2 <= len(paths) <= MAX_FRAMES:
        raise PanoramaError(400, f"Panorama stitching needs 2..{MAX_FRAMES} images, got {len(paths)}")
    # long chains inflate warp/blend buffers beyond what total input megapixels predict;
    # tighten the budget as frame count grows (measured: 13 frames at 400MP fits 6GB)
    budget = (
        min(options.maxMegapixels, options.maxMegapixels * 13.0 / len(paths))
        if len(paths) > 13
        else options.maxMegapixels
    )
    # Read -> decode -> scale -> free one frame at a time from the spool: only a single compressed
    # payload and one full-res frame are ever resident alongside the accumulating capped set.
    # An equal per-frame share of the budget matches proportional scaling for the common
    # same-resolution burst.
    allowance = budget / len(paths)
    frames: list[NDArray[np.uint8]] = []
    total_megapixels = 0.0
    for path in paths:
        with open(path, "rb") as payload_file:
            frame = _decode(payload_file.read())
        if options.compositeResolution == "preview":
            frame = _downscale(frame, PREVIEW_MAX_DIM)
        megapixels = frame.shape[0] * frame.shape[1] / 1e6
        total_megapixels += megapixels
        if megapixels > allowance:
            scale = (allowance / megapixels) ** 0.5
            frame = cast(
                NDArray[np.uint8],
                cv2.resize(
                    frame,
                    (max(1, int(frame.shape[1] * scale)), max(1, int(frame.shape[0] * scale))),
                    interpolation=cv2.INTER_AREA,
                ),
            )
        frames.append(frame)
    log.debug(f"Stitch child: decoded {len(frames)} frames, {total_megapixels:.0f}MP input")
    if total_megapixels > budget:
        log.info(
            f"Panorama input of {total_megapixels:.0f}MP exceeds {budget:.0f}MP budget, "
            f"frames capped to {allowance:.1f}MP each"
        )

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

    spherical_first = options.sphericalFallback and len(frames) >= SPHERICAL_FIRST_FRAMES
    if spherical_first:
        # A chain this long is a rotational sweep: the planar stitcher's doomed attempts on it are
        # both slow (minutes of registration) and memory-hazardous (a divergent registration can
        # imply a multi-gigabyte compose canvas before cv2's own size check throws), so run the
        # spherical pipeline first and keep planar as the second opinion.
        try:
            spherical = _stitch_spherical(frames, options)
        except cv2.error as error:
            log.warning(f"Spherical-first stitch raised: {str(error).splitlines()[-1][:120]}")
            spherical = None
        if spherical is not None:
            return spherical
        log.info("Spherical-first stitch found no coherent sweep; trying the planar pipeline")

    log.debug(f"Planar: attempting cv2.Stitcher on {len(frames)} frames")
    status, pano = try_stitch(cv2.Stitcher_PANORAMA, 0.6)
    if status != cv2.Stitcher_OK:
        status, pano = try_stitch(cv2.Stitcher_PANORAMA, 0.4)
    if status != cv2.Stitcher_OK:
        # flat subjects photographed close up (documents, boards) violate the rotational
        # model but stitch cleanly with the affine SCANS pipeline
        status, pano = try_stitch(cv2.Stitcher_SCANS, 0.5)
    def spherical_fallback_or_raise(planar_reason: str) -> StitchOutput:
        # Wide/360 rotational sweeps either fail the high-level stitcher's camera-parameter
        # adjustment (status 3) or slip through as a degenerate OK result; both recover with the
        # low-level spherical pipeline. Try it before surfacing the planar failure reason.
        if options.sphericalFallback and not spherical_first and len(frames) >= 3:
            try:
                spherical = _stitch_spherical(frames, options)
            except cv2.error as error:
                log.warning(f"Spherical fallback raised: {str(error).splitlines()[-1][:120]}")
                spherical = None
            if spherical is not None:
                return spherical
        raise PanoramaError(422, planar_reason)

    if status != cv2.Stitcher_OK or pano is None:
        reasons = {
            cv2.Stitcher_ERR_NEED_MORE_IMGS: "not enough overlapping content",
            cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL: "homography estimation failed",
            cv2.Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL: "camera parameter adjustment failed",
        }
        return spherical_fallback_or_raise(f"Stitch failed: {reasons.get(status, f'status {status}')}")
    if options.cropAuto:
        pano = _autocrop(pano)

    # A structurally broken registration can still return Stitcher_OK, either by
    # collapsing the scene into a smear far smaller than any input frame, or by
    # scattering fragments across a huge mostly-black canvas. These are exactly the wide/360
    # sweeps the spherical fallback recovers, so route degenerate planar output there too.
    median_frame_area = float(np.median([frame.shape[0] * frame.shape[1] for frame in frames]))
    if pano.shape[0] * pano.shape[1] < 0.5 * median_frame_area:
        pano = np.empty(0, dtype=np.uint8)  # release the garbage canvas before the fallback allocates
        return spherical_fallback_or_raise("Stitch failed: degenerate result (registration collapsed the scene)")
    filled = float((cv2.cvtColor(pano, cv2.COLOR_BGR2GRAY) > 8).mean())
    if filled < 0.85:
        reason = f"Stitch failed: degenerate result (canvas only {filled:.0%} filled)"
        pano = np.empty(0, dtype=np.uint8)  # a scattered-fragment canvas can be huge; free it first
        return spherical_fallback_or_raise(reason)
    missing: list[int] = []
    if options.verifySources:
        missing = _verify_sources(frames, pano)
        if missing and len(frames) - len(missing) < max(2, len(frames) // 2):
            raise PanoramaError(422, f"Stitch failed verification: source frame(s) {missing} not found in the result")
        if missing:
            # the stitcher pruned some frames but the majority composed correctly —
            # deliver the partial panorama rather than nothing
            log.warning(f"Partial panorama: {len(missing)} of {len(frames)} frames not in the result ({missing})")

    height, width = pano.shape[:2]
    log.info(f"Stitched {len(paths)} frames into {width}x{height} panorama ({width * height / 1e6:.1f}MP)")
    data, out_width, out_height = _encode_pano(pano, options.quality)
    metrics: dict[str, Any] = {
        "pipeline": "planar",
        "framesKept": len(frames) - len(missing),
        "framesTotal": len(frames),
        "fill": round(filled, 3),
        "verifyMissing": len(missing),
    }
    return data, out_width, out_height, metrics
