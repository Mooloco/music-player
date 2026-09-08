#!/usr/bin/env python3
"""Minimal music-library server for local, trusted-network testing."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import base64
import hashlib
import secrets
import subprocess
import threading
import time
from collections import OrderedDict
from contextlib import nullcontext
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.parse import parse_qs
from urllib.parse import unquote

from mutagen import File as MutagenFile

ROOT = Path(__file__).resolve().parent
# ---- 容器化配置：以下路径/端口均可用环境变量覆盖；不设置时行为与默认完全一致 ----
DATA_DIR = Path(os.environ.get("MUSIC_DATA_DIR", str(ROOT / "data"))).expanduser()
CACHE_DIR = Path(os.environ.get("MUSIC_CACHE_DIR", str(ROOT / "transcode"))).expanduser()
PORT = int(os.environ.get("MUSIC_PORT", "8090"))
DATA_FILE = DATA_DIR / "library.json"
FAVORITES_FILE = DATA_DIR / "favorites.json"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
CDLIB_FILE = DATA_DIR / "cdlibrary.json"
COVER_CACHE_DIR = DATA_DIR / "covers"
AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".opus", ".wma", ".wav", ".ape"}
_COVER_MEM_MAX_BYTES = int(os.environ.get("MUSIC_COVER_MEM_MB", "768")) * 1024 * 1024  # 封面内存缓存上限(LRU 淘汰),单位 MB
_COVER_MEM: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
_COVER_MEM_BYTES = 0
_COVER_MEM_LOCK = threading.Lock()
# 库文件写锁：自动扫描(后台线程)与手动扫描(请求线程)可能并发写 library.json/cdlibrary.json，互斥防 JSON 损坏
_DATA_WRITE_LOCK = threading.Lock()
# 扫描索引内存缓存：mtime 未变则复用，避免每个请求重复解析数 MB 的 library.json
_LIBRARY_CACHE: dict[str, Any] = {"mtime": None, "payload": None, "paths": None}
# CD 库独立缓存（与媒体库互不干扰，安全校验时两库路径合并）
_CDLIB_CACHE: dict[str, Any] = {"mtime": None, "payload": None, "paths": None}

# ============ 转码播放 ============
TRANSCODE_FILE = DATA_DIR / "transcode.json"
TRANSCODE_DEFAULTS = {"enabled": False, "format": "aac", "bitrate": 128, "cacheDir": "", "cacheSizeGB": 2}
# format -> (ffmpeg 编码器, 封装, 扩展名)
TRANSCODE_FORMATS = {"aac": ("aac", "adts", ".aac"), "mp3": ("libmp3lame", "mp3", ".mp3")}
TRANSCODE_BITRATES = {64, 96, 128, 192, 256, 320}
TRANSCODE_SIZES_GB = {0.5, 1, 2, 4, 8}
TRANSCODE_THRESHOLD = 400 * 1000  # 源文件码率超过 400kbps 才转码
PRE3_SECONDS = 3  # 预转下一首的开头缓冲秒数


def load_transcode_config() -> dict[str, Any]:
    try:
        data = json.loads(TRANSCODE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return dict(TRANSCODE_DEFAULTS)
    except Exception:
        return dict(TRANSCODE_DEFAULTS)
    config = dict(TRANSCODE_DEFAULTS)
    config.update({key: value for key, value in data.items() if key in TRANSCODE_DEFAULTS})
    return config


def save_transcode_config(config: dict[str, Any]) -> dict[str, Any]:
    cleaned = {key: config.get(key, TRANSCODE_DEFAULTS[key]) for key in TRANSCODE_DEFAULTS}
    cleaned["enabled"] = bool(cleaned["enabled"])
    if cleaned["format"] not in TRANSCODE_FORMATS:
        cleaned["format"] = "aac"
    if cleaned["bitrate"] not in TRANSCODE_BITRATES:
        cleaned["bitrate"] = 128
    if cleaned["cacheDir"] not in ("", "/tmp/transcode"):
        cleaned["cacheDir"] = ""
    if cleaned["cacheSizeGB"] not in TRANSCODE_SIZES_GB:
        cleaned["cacheSizeGB"] = 2
    TRANSCODE_FILE.parent.mkdir(parents=True, exist_ok=True)
    TRANSCODE_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    transcode_cache_dir(cleaned).mkdir(parents=True, exist_ok=True)
    return cleaned


def transcode_cache_dir(config: dict[str, Any] | None = None) -> Path:
    cfg = config or load_transcode_config()
    if cfg.get("cacheDir") == "/tmp/transcode":
        return Path("/tmp/transcode")
    return CACHE_DIR  # cacheDir 为空时跟随 MUSIC_CACHE_DIR(默认 ROOT/transcode)


def find_track_meta(track_path: str) -> tuple[int, int] | None:
    """在媒体库与 CD 库索引中查找曲目，返回 (size, duration)。
    size 直接取文件实际大小（媒体库扫描字段无 size，依赖 JSON 会导致估算永远失败）。"""
    try:
        file_size = Path(track_path).stat().st_size
    except OSError:
        return None
    for track in saved_library().get("tracks", []):
        if track.get("path") == track_path:
            return file_size, int(track.get("duration") or 0)
    for album in saved_cdlib().get("albums", []):
        for track in album.get("tracks", []):
            if track.get("path") == track_path:
                return file_size, int(track.get("duration") or 0)
    return None


def estimate_bitrate(track_path: str) -> int | None:
    """按文件大小/时长估算码率（无需重扫库）。"""
    meta = find_track_meta(track_path)
    if not meta:
        return None
    size, duration = meta
    if size <= 0 or duration <= 0:
        return None
    return round(size * 8 / duration)


def transcode_cache_key(track_path: str, fmt: str, bitrate: int) -> str:
    return f"{hashlib.md5(track_path.encode('utf-8')).hexdigest()[:16]}_{fmt}_{bitrate}"


def enforce_cache_limit(cache_dir: Path, limit_bytes: int) -> None:
    """缓存总大小超限时按 mtime 从旧到新删除（滚动淘汰）。"""
    try:
        entries = [(p, p.stat().st_mtime, p.stat().st_size) for p in cache_dir.iterdir() if p.is_file()]
    except OSError:
        return
    total = sum(item[2] for item in entries)
    if total <= limit_bytes:
        return
    for path, _mtime, size in sorted(entries, key=lambda item: item[1]):
        if total <= limit_bytes:
            break
        try:
            path.unlink()
            total -= size
        except OSError:
            pass


def transcode_cache_stats(config: dict[str, Any]) -> dict[str, Any]:
    cache_dir = transcode_cache_dir(config)
    total, count = 0, 0
    try:
        for item in cache_dir.iterdir():
            if item.is_file():
                total += item.stat().st_size
                count += 1
    except OSError:
        pass
    return {"sizeBytes": total, "fileCount": count, "path": str(cache_dir)}


def clear_transcode_cache(config: dict[str, Any]) -> dict[str, Any]:
    cache_dir = transcode_cache_dir(config)
    try:
        for item in cache_dir.iterdir():
            if item.is_file():
                item.unlink()
    except OSError:
        pass
    return transcode_cache_stats(config)


def build_pre3(track_path: str, config: dict[str, Any]) -> None:
    """后台生成下一首的开头缓冲（PRE3_SECONDS 秒）。"""
    fmt, mux, ext = TRANSCODE_FORMATS[config["format"]]
    br = config["bitrate"]
    cache_dir = transcode_cache_dir(config)
    key = transcode_cache_key(track_path, config["format"], br)
    pre3 = cache_dir / f"{key}.pre3{ext}"
    if pre3.exists() and pre3.stat().st_size > 0:
        return
    tmp = pre3.with_name(pre3.name + f".{os.getpid()}.tmp")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostdin",
           "-i", track_path, "-vn", "-c:a", fmt, "-b:a", f"{br}k", "-f", mux, "-t", str(PRE3_SECONDS), str(tmp)]
    try:
        # 预转是尽力而为：并发槽满则跳过（不抢播放转码的 CPU）
        if not _TRANSCODE_SEMAPHORE.acquire(blocking=False):
            return
        try:
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        finally:
            _TRANSCODE_SEMAPHORE.release()
        if tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(pre3)
        enforce_cache_limit(cache_dir, config["cacheSizeGB"] * 1024 ** 3)
    except Exception:
        pass
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def spawn_preload(track_path: str, config: dict[str, Any]) -> None:
    threading.Thread(target=build_pre3, args=(track_path, config), daemon=True).start()


# 转码并发上限：多核并行。仅当 CPU 核数 > 2 时留 1 个核给主服务（解析/响应），
# 核数 <= 2（如双核/单核机器）则全部核都用于转码，不做保留
def transcode_slots() -> int:
    cpus = os.cpu_count() or 2
    return max(1, cpus - 1 if cpus > 2 else cpus)


_TRANSCODE_SEMAPHORE = threading.Semaphore(transcode_slots())


def first_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return first_value(value[0]) if value else ""
    if hasattr(value, "text"):
        return first_value(value.text)
    return str(value).strip()


def read_tag(tags: Any, *names: str) -> str:
    if not tags:
        return ""
    wanted = {name.casefold() for name in names}
    for key in tags.keys():
        if str(key).casefold() in wanted:
            return first_value(tags[key])
    return ""


def read_embedded_lyrics(tags: Any) -> str:
    if not tags:
        return ""
    # ID3 USLT frames expose .text; other formats generally use a lyrics tag.
    for key in tags.keys():
        name = str(key).upper()
        if name.startswith("USLT") or name.startswith("SYLT"):
            text = first_value(tags[key])
            if text:
                return text
    return read_tag(tags, "lyrics", "unsyncedlyrics", "©lyr", "lyric")


def read_lrc(audio_path: Path) -> str:
    candidates = [audio_path.with_suffix(".lrc"), audio_path.with_suffix(".LRC")]
    try:
        candidates.extend(
            item for item in audio_path.parent.iterdir()
            if item.suffix.casefold() == ".lrc" and item.stem.casefold() == audio_path.stem.casefold()
        )
    except OSError:
        pass
    for candidate in candidates:
        if not candidate.is_file():
            continue
        raw = candidate.read_bytes()
        for encoding in ("utf-8-sig", "utf-16", "gb18030", "latin-1"):
            try:
                text = raw.decode(encoding).strip()
                if text:
                    return text
            except UnicodeDecodeError:
                continue
    return ""


def embedded_cover(audio: Any) -> tuple[bytes, str] | None:
    if getattr(audio, "pictures", None):
        picture = audio.pictures[0]
        return picture.data, picture.mime or "image/jpeg"
    tags = getattr(audio, "tags", None) or {}
    for key in tags.keys():
        value = tags[key]
        key_name = str(key).casefold()
        if key_name.startswith("apic") and getattr(value, "data", None):
            return value.data, getattr(value, "mime", "image/jpeg")
        if key_name == "covr":
            data = bytes(value[0]) if isinstance(value, (list, tuple)) else bytes(value)
            return data, "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return None


def _cover_item_size(item: tuple[bytes, str]) -> int:
    data, content_type = item
    return len(data) + len(content_type)


def _cover_mem_get(track_path: str) -> tuple[bytes, str] | None:
    """LRU 命中：取出并移到最近使用端。"""
    global _COVER_MEM_BYTES
    with _COVER_MEM_LOCK:
        item = _COVER_MEM.get(track_path)
        if item is not None:
            _COVER_MEM.move_to_end(track_path)
        return item


def _cover_mem_put(track_path: str, item: tuple[bytes, str]) -> None:
    """写入并做 LRU 淘汰：总字节数超过上限时逐出最久未使用的封面。"""
    global _COVER_MEM_BYTES
    with _COVER_MEM_LOCK:
        if track_path in _COVER_MEM:
            _COVER_MEM_BYTES -= _cover_item_size(_COVER_MEM[track_path])
        _COVER_MEM[track_path] = item
        _COVER_MEM_BYTES += _cover_item_size(item)
        while _COVER_MEM_BYTES > _COVER_MEM_MAX_BYTES and _COVER_MEM:
            _, evicted = _COVER_MEM.popitem(last=False)
            _COVER_MEM_BYTES -= _cover_item_size(evicted)


def get_cover_cached(track_path: str) -> tuple[bytes, str] | None:
    """封面读取：内存缓存 → 磁盘缓存 → 解析音频（解析结果写入两级缓存）。"""
    cached = _cover_mem_get(track_path)
    if cached:
        return cached
    digest = hashlib.md5(track_path.encode("utf-8")).hexdigest()
    img_file = COVER_CACHE_DIR / f"{digest}.img"
    meta_file = COVER_CACHE_DIR / f"{digest}.meta"
    if img_file.is_file() and meta_file.is_file():
        try:
            data = img_file.read_bytes()
            content_type = meta_file.read_text(encoding="utf-8").strip()
            _cover_mem_put(track_path, (data, content_type))
            return data, content_type
        except OSError:
            pass
    try:
        cover = embedded_cover(MutagenFile(track_path, easy=False))
    except Exception:
        cover = None
    if not cover:
        return None
    data, content_type = cover
    try:
        COVER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        img_file.write_bytes(data)
        meta_file.write_text(content_type, encoding="utf-8")
    except OSError:
        pass
    _cover_mem_put(track_path, (data, content_type))
    return data, content_type


def scan_track(path: Path) -> dict[str, Any] | None:
    try:
        audio = MutagenFile(path, easy=False)
        if audio is None:
            return None
        tags = getattr(audio, "tags", None)
        lyrics = read_embedded_lyrics(tags)
        lyric_source = "embedded" if lyrics else ""
        if not lyrics:
            lyrics = read_lrc(path)
            lyric_source = "lrc" if lyrics else ""
        duration = round(float(getattr(audio.info, "length", 0) or 0))
        return {
            "id": str(path),
            "path": str(path),
            "title": read_tag(tags, "title", "TIT2", "©nam") or path.stem,
            "artist": read_tag(tags, "artist", "TPE1", "©ART") or "未知艺人",
            "album": read_tag(tags, "album", "TALB", "©alb") or "未知专辑",
            "albumArtist": read_tag(tags, "albumartist", "TPE2", "aART") or "",
            "genre": read_tag(tags, "genre", "TCON", "©gen") or "",
            "year": read_tag(tags, "date", "year", "TDRC", "©day") or "",
            "track": read_tag(tags, "tracknumber", "TRCK", "trkn") or "",
            "duration": duration,
            "lyrics": lyrics,
            "lyricSource": lyric_source or None,
            "hasCover": bool(embedded_cover(audio)),
            "modifiedAt": path.stat().st_mtime,
        }
    except Exception:
        # A damaged or unsupported file should not stop the rest of the library.
        return None


def scan_library(raw_path: str) -> dict[str, Any]:
    library_path = Path(raw_path).expanduser().resolve()
    if not library_path.is_dir():
        raise ValueError("媒体库路径不存在或不是目录。")
    tracks = [track for file in library_path.rglob("*") if file.is_file() and file.suffix.casefold() in AUDIO_EXTENSIONS if (track := scan_track(file))]
    tracks.sort(key=lambda item: item["modifiedAt"], reverse=True)
    albums = {}
    for track in tracks:
        key = f'{track["albumArtist"] or track["artist"]}\0{track["album"]}'
        album = albums.setdefault(key, {"title": track["album"], "artist": track["albumArtist"] or track["artist"], "tracks": 0})
        album["tracks"] += 1
    payload = {"path": str(library_path), "scannedAt": datetime.now(timezone.utc).isoformat(), "tracks": tracks, "albums": list(albums.values())}
    with _DATA_WRITE_LOCK:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        DATA_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def saved_library() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {"path": "", "scannedAt": None, "tracks": [], "albums": []}
    try:
        mtime = DATA_FILE.stat().st_mtime_ns
    except OSError:
        mtime = None
    if _LIBRARY_CACHE["payload"] is not None and _LIBRARY_CACHE["mtime"] == mtime:
        return _LIBRARY_CACHE["payload"]
    # 缓存未命中：全量解析一次，并同步重建路径集合（GIL 下 dict 读写原子，多线程安全）
    payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    _LIBRARY_CACHE["mtime"] = mtime
    _LIBRARY_CACHE["payload"] = payload
    _LIBRARY_CACHE["paths"] = frozenset(item["path"] for item in payload.get("tracks", []))
    return payload


def saved_favorites() -> list[str]:
    if not FAVORITES_FILE.exists():
        return []
    try:
        return json.loads(FAVORITES_FILE.read_text(encoding="utf-8")).get("ids", [])
    except (OSError, json.JSONDecodeError):
        return []


def parse_singer_album(folder_name: str) -> str:
    """从文件夹名解析歌手：'歌手 - 专辑' / '歌手-专辑' / '歌手_专辑' 等，取分隔符前段。"""
    for sep in (" - ", "－", "-", "_"):
        if sep in folder_name:
            singer = folder_name.split(sep, 1)[0].strip()
            if len(singer) >= 2:
                return singer
    return ""


def parse_track_number(raw: str, filename: str) -> int:
    """曲目号：文件名前缀数字优先（CD 库场景文件顺序即曲目顺序），标签兜底；都没有排最后。"""
    match = re.match(r"^\s*(\d{1,3})(?![0-9])", filename)
    if match:
        return int(match.group(1))
    text = raw.split("/")[0].strip() if raw else ""
    match = re.match(r"^\s*(\d{1,3})", text)
    if match:
        return int(match.group(1))
    return 10**9


def strip_jsonc_comments(text: str) -> str:
    """去掉 JSONC 注释（// 与 /* */），字符串内的 // 不受影响；单引号字符串转为双引号（兼容方言）。"""
    out: list[str] = []
    i, n = 0, len(text)
    quote: str | None = None
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\" and i + 1 < n:
                nxt = text[i + 1]
                if quote == "'" and nxt == "'":
                    out.append("'")  # 单引号串内的 \' 在双引号串中无需转义
                else:
                    out.append(ch)
                    out.append(nxt)
                i += 2
                continue
            if ch == quote:
                out.append('"')  # 字符串结束（单引号串转为双引号串）
                quote = None
            else:
                out.append(ch)
            i += 1
            continue
        if ch == '"':
            quote = '"'
            out.append(ch)
            i += 1
            continue
        if ch == "'":
            quote = "'"
            out.append('"')
            i += 1
            continue
        if ch == "/" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "/":
                while i < n and text[i] != "\n":
                    i += 1
                continue
            if nxt == "*":
                i += 2
                while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                    i += 1
                i = min(i + 2, n)
                continue
        out.append(ch)
        i += 1
    return "".join(out)


_ALBUM_INFO_MAP = {
    "title": ("title", "name", "album", "专辑名称"),
    "artist": ("artist", "albumArtist", "singer", "歌手"),
    "genre": ("genre", "style", "type", "流派"),
    "label": ("publisher", "label", "company", "recordLabel", "发行公司"),
    "date": ("releaseDate", "date", "year", "发行日期"),
    "desc": ("description", "desc", "intro", "bio", "简介"),
    "cover": ("cover", "coverFile", "封面"),
}


def read_album_info(album_dir: Path) -> dict[str, str] | None:
    """读取专辑目录下 info.jsonc / info.json 的 album 字段（兼容中文 key），无则 None。"""
    for name in ("info.jsonc", "info.json"):
        info_file = album_dir / name
        if not info_file.is_file():
            continue
        try:
            raw = json.loads(strip_jsonc_comments(info_file.read_text(encoding="utf-8")))
        except Exception:
            return None
        if not isinstance(raw, dict):
            return None
        data = raw.get("album") if isinstance(raw.get("album"), dict) else raw
        result: dict[str, str] = {}
        for field, keys in _ALBUM_INFO_MAP.items():
            for key in keys:
                if key in data:
                    value = data[key]
                    if isinstance(value, (list, tuple)):
                        value = value[0] if value else ""
                    if isinstance(value, bool):
                        value = ""
                    elif isinstance(value, (int, float)):
                        value = str(value)
                    value = str(value).strip()
                    if value:
                        result[field] = value
                    break
        return result or None
    return None


def scan_cd_track(file: Path) -> dict[str, Any] | None:
    try:
        audio = MutagenFile(file, easy=False)
        if audio is None:
            return None
        tags = getattr(audio, "tags", None)
        track_raw = read_tag(tags, "tracknumber", "TRCK", "trkn")
        track_num = parse_track_number(track_raw, file.stem)
        lyrics = read_embedded_lyrics(tags)
        lyric_source = "embedded" if lyrics else ""
        if not lyrics:
            lyrics = read_lrc(file)
            lyric_source = "lrc" if lyrics else ""
        return {
            "id": str(file),
            "path": str(file),
            "title": read_tag(tags, "title", "TIT2", "©nam") or file.stem,
            "artist": read_tag(tags, "artist", "TPE1", "©ART"),
            "track": str(track_num) if track_num < 10**9 else "",
            "trackNum": track_num,
            "size": file.stat().st_size,
            "duration": round(float(getattr(audio.info, "length", 0) or 0)),
            "hasCover": bool(embedded_cover(audio)),
            "lyrics": lyrics,
            "lyricSource": lyric_source or None,
        }
    except Exception:
        return None


def split_artists(artist: str) -> list[str]:
    """拆分合唱/多艺人标签：'A / B'、'A; B'、'A、B'、'A feat. B' 等。"""
    parts = re.split(r"[/、;&,，]|\bfeat\.?|\bft\.?|\bwith\b|\band\b|与", artist, flags=re.IGNORECASE)
    return [part.strip() for part in parts if part.strip()]


def most_common_artist(tracks: list[dict[str, Any]]) -> str:
    """专辑内所有歌曲艺人中出现次数最多的（合唱按多艺人拆分统计），并列取先出现者。"""
    counter: dict[str, int] = {}
    for track in tracks:
        for name in split_artists(track.get("artist") or ""):
            counter[name] = counter.get(name, 0) + 1
    if not counter:
        return ""
    max_count = max(counter.values())
    for track in tracks:
        for name in split_artists(track.get("artist") or ""):
            if counter[name] == max_count:
                return name
    return ""


def scan_cd_album(album_dir: Path) -> dict[str, Any] | None:
    """扫描一个专辑文件夹（只读直接子文件，不递归子子文件夹）。"""
    tracks = []
    for file in sorted(album_dir.iterdir(), key=lambda item: item.name.casefold()):
        if not file.is_file() or file.suffix.casefold() not in AUDIO_EXTENSIONS:
            continue
        track = scan_cd_track(file)
        if track:
            tracks.append(track)
    if not tracks:
        return None
    tracks.sort(key=lambda item: (item["trackNum"], item["title"].casefold()))
    info = read_album_info(album_dir)
    # 歌手优先级：info.jsonc > 全专辑艺人频次统计（合唱去重） > 文件夹名解析 > 未知
    artist = (info or {}).get("artist", "") or most_common_artist(tracks) or parse_singer_album(album_dir.name) or "未知歌手"
    cover_names = ("cover.jpg", "cover.png", "Cover.jpg", "Cover.png", "cover.JPG")
    if info and info.get("cover"):
        cover_names = (info["cover"],) + cover_names
    has_folder_cover = any((album_dir / name).is_file() for name in cover_names)
    return {
        "title": album_dir.name,
        "artist": artist,
        "dir": str(album_dir),
        "hasFolderCover": has_folder_cover,
        "hasCover": has_folder_cover or bool(tracks[0].get("hasCover")),
        "info": info,
        "tracks": tracks,
    }


def scan_cdlib(raw_path: str) -> dict[str, Any]:
    """扫描 CD 库：路径的第一层子文件夹作为专辑目录，与媒体库完全独立。"""
    cd_root = Path(raw_path).expanduser().resolve()
    if not cd_root.is_dir():
        raise ValueError("CD库路径不存在或不是目录。")
    albums = []
    for entry in sorted(cd_root.iterdir(), key=lambda item: item.name.casefold()):
        if not entry.is_dir():
            continue
        album = scan_cd_album(entry)
        if album:
            albums.append(album)
    payload = {"path": str(cd_root), "scannedAt": datetime.now(timezone.utc).isoformat(), "albums": albums}
    with _DATA_WRITE_LOCK:
        CDLIB_FILE.parent.mkdir(parents=True, exist_ok=True)
        CDLIB_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def saved_cdlib() -> dict[str, Any]:
    if not CDLIB_FILE.exists():
        return {"path": "", "scannedAt": None, "albums": []}
    try:
        mtime = CDLIB_FILE.stat().st_mtime_ns
    except OSError:
        mtime = None
    if _CDLIB_CACHE["payload"] is not None and _CDLIB_CACHE["mtime"] == mtime:
        return _CDLIB_CACHE["payload"]
    payload = json.loads(CDLIB_FILE.read_text(encoding="utf-8"))
    paths = set()
    for album in payload.get("albums", []):
        paths.update(item["path"] for item in album.get("tracks", []))
    _CDLIB_CACHE["mtime"] = mtime
    _CDLIB_CACHE["payload"] = payload
    _CDLIB_CACHE["paths"] = frozenset(paths)
    return payload


def saved_cdlib_paths() -> frozenset[str]:
    if _CDLIB_CACHE["paths"] is None:
        saved_cdlib()
    return _CDLIB_CACHE["paths"] or frozenset()


def save_favorites(ids: list[str]) -> None:
    FAVORITES_FILE.parent.mkdir(parents=True, exist_ok=True)
    FAVORITES_FILE.write_text(json.dumps({"ids": ids}, ensure_ascii=False), encoding="utf-8")


def saved_playlists() -> list[dict[str, Any]]:
    if not PLAYLISTS_FILE.exists():
        return []
    try:
        return json.loads(PLAYLISTS_FILE.read_text(encoding="utf-8")).get("playlists", [])
    except (OSError, json.JSONDecodeError):
        return []


def save_playlists(playlists: list[dict[str, Any]]) -> None:
    PLAYLISTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PLAYLISTS_FILE.write_text(json.dumps({"playlists": playlists}, ensure_ascii=False, indent=2), encoding="utf-8")


def find_playlist(playlists: list[dict[str, Any]], playlist_id: str) -> dict[str, Any] | None:
    for playlist in playlists:
        if playlist.get("id") == playlist_id:
            return playlist
    return None


def new_playlist_id() -> str:
    return f"pl_{int(time.time())}_{secrets.token_hex(3)}"


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端（切换页面/刷新）主动断开，静默结束
            pass

    def do_GET(self) -> None:
        request_url = urlparse(self.path)
        if request_url.path == "/api/library":
            self.send_json(saved_library())
            return
        if request_url.path == "/api/favorites":
            self.send_json({"ids": saved_favorites()})
            return
        if request_url.path == "/api/playlists":
            self.send_json({"playlists": saved_playlists()})
            return
        if request_url.path == "/api/cdlib":
            self.send_json(saved_cdlib())
            return
        if request_url.path == "/api/cdlib/cover":
            self.send_cd_cover(parse_qs(request_url.query).get("album", [""])[0])
            return
        if request_url.path == "/api/stream":
            self.stream_track(parse_qs(request_url.query).get("id", [""])[0])
            return
        if request_url.path == "/api/transcode-config":
            self.send_json(load_transcode_config())
            return
        if request_url.path == "/api/transcode-cache":
            self.send_json(transcode_cache_stats(load_transcode_config()))
            return
        if request_url.path == "/api/cover":
            self.send_cover(parse_qs(request_url.query).get("id", [""])[0])
            return
        super().do_GET()

    def is_indexed_track(self, track_id: str) -> str | None:
        try:
            track_path = str(Path(track_id).resolve())
        except OSError:
            return None
        indexed_paths = _LIBRARY_CACHE["paths"]
        if indexed_paths is None:
            saved_library()
            indexed_paths = _LIBRARY_CACHE["paths"] or frozenset()
        if track_path in indexed_paths or track_path in saved_cdlib_paths():
            if Path(track_path).is_file():
                return track_path
        return None

    def send_cover(self, track_id: str) -> None:
        track_path = self.is_indexed_track(track_id)
        if not track_path:
            # 注意：send_error 的 message 会写入 HTTP 状态行，http.server 用 latin-1 编码，中文会导致 UnicodeEncodeError
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        cover = get_cover_cached(track_path)
        if not cover:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data, content_type = cover
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # 封面与音频文件绑定，永久缓存（浏览器第二次打开直接命中本地）
        self.send_header("Cache-Control", "public, max-age=2592000, immutable")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_cd_cover(self, album_dir: str) -> None:
        """CD 专辑封面：文件夹内 cover.jpg/png 优先，回退到曲目号 1 的内嵌封面。"""
        album_path = str(Path(album_dir).resolve())
        album = next((item for item in saved_cdlib().get("albums", []) if item.get("dir") == album_path), None)
        if not album:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        cover_names = ("cover.jpg", "cover.png", "Cover.jpg", "Cover.png", "cover.JPG")
        if album.get("info") and album["info"].get("cover"):
            cover_names = (album["info"]["cover"],) + cover_names
        for name in cover_names:
            cover_file = Path(album_path) / name
            if cover_file.is_file():
                data = cover_file.read_bytes()
                content_type = "image/jpeg" if name.casefold().endswith(".jpg") else "image/png"
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=2592000, immutable")
                self.end_headers()
                self.wfile.write(data)
                return
        track_one = next((item for item in album.get("tracks", []) if item.get("trackNum") == 1), None)
        if track_one and track_one.get("hasCover"):
            cover = get_cover_cached(track_one["path"])
            if cover:
                data, content_type = cover
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=2592000, immutable")
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _pipe_ffmpeg(self, track_path: str, codec: str, mux: str, bitrate: int, cache_path: Path | None, skip_seconds: int = 0) -> None:
        """ffmpeg 边转边播：stdout 逐块发给客户端；cache_path 非空时双写落盘（tmp 原子改名）。"""
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostdin"]
        if skip_seconds:
            cmd += ["-ss", str(skip_seconds)]
        cmd += ["-i", track_path, "-vn", "-c:a", codec, "-b:a", f"{bitrate}k", "-f", mux, "-"]
        tmp_cache = cache_path.with_name(cache_path.name + f".{os.getpid()}.tmp") if cache_path else None
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            with (tmp_cache.open("wb") if tmp_cache else nullcontext()) as cache_out:
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    if cache_out:
                        cache_out.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()
            if tmp_cache:
                try:
                    tmp_cache.unlink()
                except OSError:
                    pass
        finally:
            proc.wait()
            if tmp_cache and tmp_cache.exists() and tmp_cache.stat().st_size > 0:
                tmp_cache.replace(cache_path)
                enforce_cache_limit(cache_path.parent, load_transcode_config()["cacheSizeGB"] * 1024 ** 3)

    def serve_transcoded(self, track_path: str, config: dict[str, Any], seek_sec: int = 0) -> None:
        """转码播放主入口：完整缓存 -> pre3+管道 -> 纯管道（seek）。
        seek_sec：前端 &seek= 参数（转码管道从该秒起输出）；浏览器对缓存文件仍走 Range。"""
        fmt, mux, ext = TRANSCODE_FORMATS[config["format"]]
        br = config["bitrate"]
        cache_dir = transcode_cache_dir(config)
        cache_dir.mkdir(parents=True, exist_ok=True)
        key = transcode_cache_key(track_path, config["format"], br)
        cache_file = cache_dir / f"{key}{ext}"
        pre3_file = cache_dir / f"{key}.pre3{ext}"
        byte_range = self.headers.get("Range", "")
        match = re.match(r"bytes=(\d*)-(\d*)", byte_range)
        range_start = int(match.group(1)) if match and match.group(1) else (seek_sec if seek_sec > 0 else 0)
        # Content-Type 必须用标准 MIME：aac -> audio/aac，mp3 -> audio/mpeg（曾误用编码器名 audio/libmp3lame）
        content_type = "audio/mpeg" if config["format"] == "mp3" else "audio/aac"
        # 1) 完整缓存存在：走 Range 文件发送（支持 seek）
        if cache_file.is_file() and cache_file.stat().st_size > 0:
            self.send_file_range(cache_file, byte_range, content_type)
            return
        # 2) 顺序播放且有预转缓冲：先发 pre3 立即出声，再从 3 秒处继续管道（双写缓存）
        if range_start == 0 and pre3_file.is_file() and pre3_file.stat().st_size > 0:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                with open(pre3_file, "rb") as source:
                    while True:
                        chunk = source.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                with _TRANSCODE_SEMAPHORE:
                    self._pipe_ffmpeg(track_path, fmt, mux, br, cache_file, skip_seconds=PRE3_SECONDS)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        # 3) 无缓冲 / seek：直接管道（seek 不落盘，避免缓存错位）
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with _TRANSCODE_SEMAPHORE:
                self._pipe_ffmpeg(track_path, fmt, mux, br, cache_file if range_start == 0 else None, skip_seconds=range_start)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file_range(self, file_path: Path, byte_range: str, content_type: str) -> None:
        """按 Range 发送文件（用于转码缓存命中）。"""
        file_size = file_path.stat().st_size
        match = re.match(r"bytes=(\d*)-(\d*)", byte_range)
        start, end, status = 0, file_size - 1, HTTPStatus.OK
        if match:
            start = int(match.group(1) or 0)
            end = int(match.group(2) or end)
            if start >= file_size or start > end:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            end = min(end, file_size - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        with open(file_path, "rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def stream_track(self, track_id: str) -> None:
        track_path = self.is_indexed_track(track_id)
        if not track_path:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        # 转码分支：前端带 transcode=1 且配置开启且源码率超过阈值时才走转码
        query = parse_qs(urlparse(self.path).query)
        if query.get("transcode", [""])[0] == "1":
            config = load_transcode_config()
            if config["enabled"]:
                bitrate = estimate_bitrate(track_path)
                if bitrate and bitrate > TRANSCODE_THRESHOLD:
                    seek_sec = 0
                    try:
                        seek_sec = int(float(query.get("seek", ["0"])[0] or 0))
                    except ValueError:
                        seek_sec = 0
                    self.serve_transcoded(track_path, config, seek_sec)
                    return
        file_size = Path(track_path).stat().st_size
        content_type = mimetypes.guess_type(track_path)[0] or "application/octet-stream"
        byte_range = self.headers.get("Range", "")
        match = re.match(r"bytes=(\d*)-(\d*)", byte_range)
        start, end, status = 0, file_size - 1, HTTPStatus.OK
        if match:
            start = int(match.group(1) or 0)
            end = int(match.group(2) or end)
            if start >= file_size or start > end:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            end = min(end, file_size - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        with open(track_path, "rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # 客户端（浏览器切歌/停止）主动断开，静默结束，不刷日志
                    break
                remaining -= len(chunk)

    def do_POST(self) -> None:
        endpoint = urlparse(self.path).path
        if endpoint not in {"/api/library/scan", "/api/cdlib/scan", "/api/favorites", "/api/playlists", "/api/playlists/add", "/api/playlists/remove", "/api/transcode-config", "/api/transcode-cache/clear", "/api/transcode/preload"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            if endpoint == "/api/transcode-config":
                self.send_json(save_transcode_config(request))
                return
            if endpoint == "/api/transcode-cache/clear":
                self.send_json(clear_transcode_cache(load_transcode_config()))
                return
            if endpoint == "/api/transcode/preload":
                # body 里的 id 可能是 URL 编码的（兼容），防御性解码
                track_path = self.is_indexed_track(unquote(str(request.get("id", ""))))
                if track_path:
                    config = load_transcode_config()
                    if config["enabled"]:
                        bitrate = estimate_bitrate(track_path)
                        if bitrate and bitrate > TRANSCODE_THRESHOLD:
                            spawn_preload(track_path, config)
                self.send_json({"ok": True})
                return
            if endpoint == "/api/library/scan":
                self.send_json(scan_library(str(request.get("path", "")).strip()))
                return
            if endpoint == "/api/cdlib/scan":
                self.send_json(scan_cdlib(str(request.get("path", "")).strip()))
                return
            if endpoint == "/api/favorites":
                track_id = str(request.get("id", ""))
                if not self.is_indexed_track(track_id):
                    raise ValueError("只能收藏已扫描的歌曲。")
                ids = saved_favorites()
                if request.get("favorite"):
                    ids = [item for item in ids if item != track_id]
                    ids.insert(0, track_id)
                else:
                    ids = [item for item in ids if item != track_id]
                save_favorites(ids)
                self.send_json({"ids": ids})
                return
            if endpoint == "/api/playlists":
                self.create_playlist(str(request.get("name", "")).strip())
                return
            if endpoint == "/api/playlists/add":
                self.add_to_playlist(request)
                return
            if endpoint == "/api/playlists/remove":
                self.remove_from_playlist(request)
                return
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            self.send_json({"error": "请求处理失败，请检查请求数据及服务端权限。"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def create_playlist(self, name: str) -> None:
        name = name.strip()
        if not name:
            raise ValueError("歌单名称不能为空。")
        playlists = saved_playlists()
        playlist = {"id": new_playlist_id(), "name": name, "createdAt": int(time.time()), "tracks": []}
        playlists.insert(0, playlist)
        save_playlists(playlists)
        self.send_json(playlist)

    def add_to_playlist(self, request: dict[str, Any]) -> None:
        playlist_id = str(request.get("playlistId", ""))
        track_ids = request.get("trackIds")
        if not isinstance(track_ids, list):
            raise ValueError("trackIds 必须是数组。")
        playlists = saved_playlists()
        playlist = find_playlist(playlists, playlist_id)
        if not playlist:
            raise ValueError("歌单不存在。")
        now = int(time.time())
        added, skipped = 0, 0
        existing = {item["id"] for item in playlist["tracks"]}
        for track_id in track_ids:
            if not self.is_indexed_track(str(track_id)):
                skipped += 1
                continue
            if track_id in existing:
                # 重复加入：刷新加入时间，使该曲移到最前（最近加入排第一）
                for item in playlist["tracks"]:
                    if item["id"] == track_id:
                        item["addedAt"] = now
                        break
            else:
                playlist["tracks"].append({"id": track_id, "addedAt": now})
                existing.add(track_id)
            added += 1
        playlist["tracks"].sort(key=lambda item: item["addedAt"], reverse=True)
        save_playlists(playlists)
        self.send_json({"playlist": playlist, "added": added, "skipped": skipped})

    def remove_from_playlist(self, request: dict[str, Any]) -> None:
        playlist_id = str(request.get("playlistId", ""))
        track_id = str(request.get("trackId", ""))
        playlists = saved_playlists()
        playlist = find_playlist(playlists, playlist_id)
        if not playlist:
            raise ValueError("歌单不存在。")
        playlist["tracks"] = [item for item in playlist["tracks"] if item["id"] != track_id]
        save_playlists(playlists)
        self.send_json({"playlist": playlist})

    def do_DELETE(self) -> None:
        request_url = urlparse(self.path)
        if request_url.path == "/api/playlists":
            playlist_id = parse_qs(request_url.query).get("id", [""])[0]
            playlists = saved_playlists()
            if not find_playlist(playlists, playlist_id):
                self.send_json({"error": "歌单不存在。"}, HTTPStatus.NOT_FOUND)
                return
            playlists = [playlist for playlist in playlists if playlist.get("id") != playlist_id]
            save_playlists(playlists)
            self.send_json({"deleted": playlist_id})
            return
        self.send_error(HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    mimetypes.add_type("audio/flac", ".flac")

    # 容器/首启增强：MUSIC_LIBRARY_PATH / MUSIC_CDLIB_PATH 已设置且库文件不存在时，
    # 后台自动扫描（不阻塞 serve_forever），完成后前端刷新即见数据；库已存在则跳过。
    def auto_scan_if_needed() -> None:
        def _scan(kind: str, env_name: str, path: str) -> None:
            try:
                if kind == "library":
                    scan_library(path)
                else:
                    scan_cdlib(path)
                print(f"[music-player] 自动扫描 {kind} 完成: {path}", flush=True)
            except Exception as exc:
                print(f"[music-player] 自动扫描 {kind} 失败: {exc}", flush=True)

        for kind, env_name, target in (("library", "MUSIC_LIBRARY_PATH", DATA_FILE),
                                       ("cdlib", "MUSIC_CDLIB_PATH", CDLIB_FILE)):
            path = os.environ.get(env_name, "").strip()
            if not path:
                continue
            if target.exists():
                print(f"[music-player] {env_name} 已设置但库文件已存在，跳过自动扫描: {target}", flush=True)
                continue
            print(f"[music-player] 检测到 {env_name}={path}，后台自动扫描…", flush=True)
            threading.Thread(target=_scan, args=(kind, env_name, path), daemon=True).start()

    auto_scan_if_needed()
    ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler).serve_forever()
