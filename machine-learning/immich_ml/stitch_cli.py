"""Isolated panorama-stitch entry point.

Runs as `python -m immich_ml.stitch_cli <spool_dir>`: a plain fork+exec subprocess rather than
multiprocessing, so there is no bootstrap pickling, no inherited locks and no __mp_main__
re-import to go wrong under a threaded gunicorn parent. The spool directory carries the contract:

    options.json   StitchOptions (written by the parent)
    NNN.bin        ordered compressed frame payloads
    result.bin     produced on success (encoded panorama)
    result.json    {"width": W, "height": H} on success, {"status_code": S, "message": M} on error

stderr is captured to a file by the parent, so every log line and traceback from the pipeline is
inspectable even when this process is killed."""

import json
import logging
import os
import resource
import sys


def _cap_address_space() -> None:
    override_mb = os.environ.get("MACHINE_LEARNING_PANO_MEMORY_MB", "").strip()
    if override_mb.isdigit() and int(override_mb) > 0:
        # operator override: hard heap budget for the stitch process, independent of cgroup detection
        cap = int(override_mb) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_DATA, (cap, cap))
        resource.setrlimit(resource.RLIMIT_AS, (cap * 4, cap * 4))
        return
    try:
        raw = open("/sys/fs/cgroup/memory.max").read().strip()
        limit = None if raw == "max" else int(raw)
    except (OSError, ValueError):
        limit = None
    if limit is not None:
        # leave headroom for the gunicorn worker sharing the cgroup; exhaustion then raises
        # MemoryError here instead of the kernel OOM-killing an arbitrary cgroup member
        cap = max(limit - 1536 * 1024 * 1024, limit // 2)
    else:
        # no cgroup limit: never run uncapped — a runaway compose once ballooned to 33GB RSS and
        # took down the whole host. Default to a third of system memory, at most 8GB.
        try:
            with open("/proc/meminfo") as meminfo:
                total_kb = int(next(line for line in meminfo if line.startswith("MemTotal")).split()[1])
            cap = min(total_kb * 1024 // 3, 8 * 1024 * 1024 * 1024)
        except (OSError, ValueError, StopIteration):
            cap = 8 * 1024 * 1024 * 1024
    # RLIMIT_DATA tracks the heap (what the runaway actually consumes); RLIMIT_AS counts virtual
    # reservations, which run several times higher than resident use under threaded cv2/numpy and
    # strangle legitimate work. Keep AS as a loose outer net at 4x.
    resource.setrlimit(resource.RLIMIT_DATA, (cap, cap))
    resource.setrlimit(resource.RLIMIT_AS, (cap * 4, cap * 4))


def _default_threads() -> int:
    # cv2 sizes its pool from host CPUs, but a container CPU quota can be far lower; honour the
    # cgroup quota so the stitch doesn't oversubscribe (and allocate arenas for) phantom cores
    try:
        quota_raw, period_raw = open("/sys/fs/cgroup/cpu.max").read().split()
        if quota_raw != "max":
            return max(1, int(quota_raw) // int(period_raw))
    except (OSError, ValueError):
        pass
    return 0  # let cv2 use its default


def main() -> int:
    spool_dir = sys.argv[1]
    logging.basicConfig(level=logging.DEBUG, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    _cap_address_space()

    import glob

    import cv2

    from immich_ml import panorama
    from immich_ml.config import settings

    with open(f"{spool_dir}/options.json") as options_file:
        options = panorama.StitchOptions.model_validate_json(options_file.read())
    paths = sorted(glob.glob(f"{spool_dir}/*.bin"))

    try:
        cv2.setRNGSeed(42)  # deterministic RANSAC/BA: the same input always converges the same way
        threads = options.threads or settings.pano_threads or _default_threads()
        if threads > 0:
            cv2.setNumThreads(threads)
        data, width, height = panorama._stitch(paths, options)
    except panorama.PanoramaError as error:
        with open(f"{spool_dir}/result.json", "w") as result_file:
            json.dump({"status_code": error.status_code, "message": error.message}, result_file)
        return 0
    except MemoryError:
        with open(f"{spool_dir}/result.json", "w") as result_file:
            json.dump(
                {"status_code": 422, "message": "Stitch failed: out of memory (lower the megapixel budget)"},
                result_file,
            )
        return 0

    with open(f"{spool_dir}/result.bin", "wb") as data_file:
        data_file.write(data)
    with open(f"{spool_dir}/result.json", "w") as result_file:
        json.dump({"width": width, "height": height}, result_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
