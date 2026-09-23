from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "stock_daily.parquet"
CACHE_BARS = 320


def date_text(value) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)[:10]


def exchange_name(code: str) -> str:
    if code.endswith(".SZ"):
        return "深市"
    if code.endswith(".SH"):
        return "沪市"
    if code.endswith(".BJ"):
        return "北交所"
    return "市场"


def market_group(code: str) -> str:
    number = code.split(".", 1)[0]
    if number.startswith(("688", "300", "301")):
        return "成长"
    if number.startswith(("000", "001", "002", "003", "600", "601", "603", "605")):
        return "主板"
    if number.startswith(("4", "8", "92")) or code.endswith(".BJ"):
        return "北交所"
    return "其他"


def rounded(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def resample(values: np.ndarray, count: int) -> np.ndarray:
    if len(values) == count:
        return values.astype(float, copy=False)
    if len(values) < 2:
        return np.repeat(float(values[0]) if len(values) else 0.0, count)
    positions = np.linspace(0, len(values) - 1, count)
    left = np.floor(positions).astype(int)
    right = np.minimum(left + 1, len(values) - 1)
    weight = positions - left
    return values[left] * (1.0 - weight) + values[right] * weight


def normalize_path(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if values.ndim == 1:
        values = values[None, :]
    base = values[:, :1]
    span = np.ptp(values, axis=1, keepdims=True)
    return (values - base) / np.maximum(span, 1e-8)


class MarketIndex:
    def __init__(self, path: Path):
        self.path = path
        self.parquet: pq.ParquetFile | None = None
        self.metadata: list[dict] = []
        self.by_code: dict[str, dict] = {}
        self.cache: dict[str, dict] = {}
        self.cache_ready = False
        self.metadata_ready = False
        self.metadata_lock = threading.Lock()
        self.cache_lock = threading.Lock()
        stat = path.stat()
        self.file_signature = (stat.st_mtime_ns, stat.st_size)
        self._build_metadata()

    def _build_metadata_locked(self) -> None:
        parquet = pq.ParquetFile(self.path)
        try:
            fields = {name: parquet.schema_arrow.get_field_index(name) for name in [
                "trade_date", "stock_code"
            ]}
            items = []
            for row_group_index in range(parquet.num_row_groups):
                row_group = parquet.metadata.row_group(row_group_index)
                code_stats = row_group.column(fields["stock_code"]).statistics
                date_stats = row_group.column(fields["trade_date"]).statistics
                if not code_stats:
                    continue
                code = str(code_stats.min)
                item = {
                    "code": code,
                    "group": market_group(code),
                    "exchange": exchange_name(code),
                    "row_group": row_group_index,
                    "rows": row_group.num_rows,
                    "start": date_text(date_stats.min) if date_stats else "",
                    "latest": date_text(date_stats.max) if date_stats else "",
                }
                items.append(item)
                self.by_code[code] = item
            self.metadata = items
            self.metadata_ready = True
        finally:
            parquet.close()

    def _build_metadata(self) -> None:
        if self.metadata_ready:
            return
        with self.metadata_lock:
            if not self.metadata_ready:
                self._build_metadata_locked()

    def refresh_if_changed(self) -> bool:
        stat = self.path.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self.file_signature:
            return False
        with self.metadata_lock:
            if signature == self.file_signature:
                return False
            with self.cache_lock:
                if self.parquet is not None:
                    self.parquet.close()
                    self.parquet = None
                self.metadata = []
                self.by_code = {}
                self.cache = {}
                self.cache_ready = False
                self.metadata_ready = False
                self._build_metadata_locked()
                self.file_signature = signature
        print(f"Reloaded market data: {self.path.name} ({signature[1]:,} bytes)", flush=True)
        return True

    def overview(self) -> dict:
        self.refresh_if_changed()
        self._build_metadata()
        counts: dict[str, int] = {}
        for item in self.metadata:
            counts[item["group"]] = counts.get(item["group"], 0) + 1
        latest_date = max((item["latest"] for item in self.metadata), default="")
        try:
            lag_days = max(0, (date.today() - date.fromisoformat(latest_date)).days)
        except ValueError:
            lag_days = None
        return {
            "stock_count": len(self.metadata),
            "row_count": sum(item["rows"] for item in self.metadata),
            "history_start": min((item["start"] for item in self.metadata), default=""),
            "latest_date": latest_date,
            "data_lag_days": lag_days,
            "data_fresh": lag_days is not None and lag_days <= 3,
            "frequency": "daily",
            "groups": counts,
            "cache_ready": self.cache_ready,
        }

    def _load_one(self, item: dict) -> tuple[str, dict]:
        table = self.parquet.read_row_group(
            item["row_group"],
            columns=["trade_date", "open", "high", "low", "close", "volume"],
        )
        count = table.num_rows
        start = max(0, count - CACHE_BARS)

        def numeric(name: str) -> np.ndarray:
            values = table[name].to_numpy(zero_copy_only=False).astype(float, copy=False)
            return np.nan_to_num(values[start:], nan=0.0, posinf=0.0, neginf=0.0)

        dates = table["trade_date"].to_numpy(zero_copy_only=False)[start:]
        dates = dates.astype("datetime64[D]").astype(str).tolist()
        result = {
            "dates": dates,
            "open": numeric("open"),
            "high": numeric("high"),
            "low": numeric("low"),
            "close": numeric("close"),
            "volume": numeric("volume"),
        }
        return item["code"], result

    def load_cache(self) -> None:
        self.refresh_if_changed()
        if self.cache_ready:
            return
        with self.cache_lock:
            if self.cache_ready:
                return
            started = time.perf_counter()
            with ThreadPoolExecutor(max_workers=8) as executor:
                self.parquet = pq.ParquetFile(self.path)
                try:
                    loaded = executor.map(self._load_one, self.metadata)
                    for code, series in loaded:
                        self.cache[code] = series
                finally:
                    self.parquet.close()
                    self.parquet = None
            self.cache_ready = True
            elapsed = time.perf_counter() - started
            print(f"Loaded {len(self.cache)} symbols in {elapsed:.2f}s", flush=True)

    def symbols(self, group: str = "all", limit: int = 100) -> list[dict]:
        items = self.metadata
        if group and group != "all":
            items = [item for item in items if item["group"] == group]
        return items[: max(1, min(limit, 500))]

    def quotes(self, codes: list[str]) -> list[dict]:
        self.load_cache()
        results = []
        for code in codes[:100]:
            item = self.by_code.get(code)
            series = self.cache.get(code)
            if not item or not series or not len(series["close"]):
                continue
            close = series["close"]
            volume = series["volume"]
            latest = float(close[-1])
            previous = float(close[-2]) if len(close) > 1 else latest
            base_5 = float(close[-6]) if len(close) > 5 else float(close[0])
            base_20 = float(close[-21]) if len(close) > 20 else float(close[0])
            recent_volume = float(np.mean(volume[-5:])) if len(volume) >= 5 else float(np.mean(volume))
            reference_volume = float(np.mean(volume[-25:-5])) if len(volume) > 25 else float(np.mean(volume))
            path = close[-40:] if len(close) >= 40 else close
            path_min = float(np.min(path))
            path_max = float(np.max(path))
            normalized = (path - path_min) / max(path_max - path_min, 1e-8)
            results.append({
                "code": code,
                "exchange": item["exchange"],
                "group": item["group"],
                "latest_date": series["dates"][-1],
                "latest_price": rounded(latest, 2),
                "day_change": rounded((latest / max(previous, 1e-8) - 1.0) * 100.0, 2),
                "return_5d": rounded((latest / max(base_5, 1e-8) - 1.0) * 100.0, 2),
                "return_20d": rounded((latest / max(base_20, 1e-8) - 1.0) * 100.0, 2),
                "volume_ratio": rounded(recent_volume / max(reference_volume, 1e-8), 2),
                "trend": "偏强" if latest >= base_20 * 1.06 else "回撤" if latest <= base_20 * 0.94 else "整理",
                "path": [rounded(value, 4) for value in normalized.tolist()],
            })
        return results

    def _result_candles(self, series: dict, start: int, end: int, match_start: int | None = None, match_end: int | None = None) -> list[dict]:
        candles = []
        for index in range(start, min(end, len(series["dates"]))):
            candles.append({
                "date": series["dates"][index],
                "open": rounded(series["open"][index], 2),
                "high": rounded(series["high"][index], 2),
                "low": rounded(series["low"][index], 2),
                "close": rounded(series["close"][index], 2),
                "volume": rounded(series["volume"][index], 0),
                "match": match_start is None or (match_start <= index < (match_end if match_end is not None else end)),
            })
        return candles

    def _score_windows(self, close: np.ndarray, query: np.ndarray, lookback: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        windows = np.lib.stride_tricks.sliding_window_view(close, lookback)
        sample_positions = np.linspace(0, lookback - 1, len(query))
        left = np.floor(sample_positions).astype(int)
        right = np.minimum(left + 1, lookback - 1)
        weight = sample_positions - left
        sampled = windows[:, left] * (1.0 - weight) + windows[:, right] * weight
        normalized = normalize_path(sampled)
        query_row = query.reshape(1, -1)
        distance = np.mean((normalized - query_row) ** 2, axis=1)
        velocity_distance = np.mean((np.diff(normalized, axis=1) - np.diff(query_row, axis=1)) ** 2, axis=1)
        total_distance = distance * 0.78 + velocity_distance * 0.22
        return windows, normalized, total_distance

    def _history_stats(self, series: dict, query: np.ndarray, lookback: int, recent_exclusion: int = 20) -> dict:
        close = series["close"]
        horizon = min(15, max(6, lookback // 3))
        usable_end = len(close) - max(horizon, recent_exclusion)
        if usable_end < lookback + 1:
            return {"count": 0, "hit_rate": None, "median_return": None, "p25_return": None, "p75_return": None, "median_drawdown": None}
        _, _, distances = self._score_windows(close[:usable_end], query, lookback)
        selected_starts: list[int] = []
        returns: list[float] = []
        drawdowns: list[float] = []
        min_separation = max(5, lookback // 2)
        for start in np.argsort(distances):
            start = int(start)
            if any(abs(start - previous) < min_separation for previous in selected_starts):
                continue
            end = start + lookback
            base = max(float(close[end - 1]), 1e-8)
            future = close[end:min(len(close), end + horizon)]
            if len(future) < max(3, horizon // 2):
                continue
            returns.append(float(future[-1] / base - 1.0))
            drawdowns.append(float(np.min(future) / base - 1.0))
            selected_starts.append(start)
            if len(returns) >= 30:
                break
        if not returns:
            return {"count": 0, "hit_rate": None, "median_return": None, "p25_return": None, "p75_return": None, "median_drawdown": None}
        values = np.asarray(returns, dtype=float)
        return {
            "count": len(returns),
            "hit_rate": rounded(float(np.mean(values > 0.0) * 100.0), 1),
            "median_return": rounded(float(np.median(values) * 100.0), 1),
            "p25_return": rounded(float(np.percentile(values, 25) * 100.0), 1),
            "p75_return": rounded(float(np.percentile(values, 75) * 100.0), 1),
            "median_drawdown": rounded(float(np.median(np.asarray(drawdowns)) * 100.0), 1),
        }

    def _window_result(self, item: dict, series: dict, normalized_path: np.ndarray, start: int, end: int, score: float, mode: str, age_bars: int = 0, forward_return: float | None = None) -> dict:
        close = series["close"]
        window_volume = float(np.mean(series["volume"][start:end]))
        before_start = max(0, start - (end - start))
        before_volume = float(np.mean(series["volume"][before_start:start])) if start > before_start else window_volume
        volume_ratio = window_volume / max(before_volume, 1e-8)
        pattern = resample(normalized_path, 32)
        pattern_min = float(np.min(pattern))
        pattern_max = float(np.max(pattern))
        pattern = (pattern - pattern_min) / max(pattern_max - pattern_min, 1e-8)
        chart_start = max(0, start - 12)
        chart_end = min(len(close), max(end + 12, end))
        if mode == "current":
            chart_end = len(close)
        if forward_return is not None:
            phase = "加速上行" if forward_return >= 0.045 else "震荡整理" if forward_return > -0.035 else "回撤观察"
        else:
            recent_return = close[-1] / max(close[start], 1e-8) - 1.0
            phase = "当前候选" if age_bars == 0 else "近期形态"
            if recent_return < -0.08:
                phase = "回撤观察"
            elif recent_return > 0.08:
                phase = "趋势偏强"
        return {
            "code": item["code"],
            "exchange": item["exchange"],
            "group": item["group"],
            "score": rounded(score, 1),
            "match_start": series["dates"][start],
            "match_end": series["dates"][end - 1],
            "latest_date": series["dates"][-1],
            "latest_price": rounded(close[-1], 2),
            "forward_return": rounded(forward_return * 100.0, 1) if forward_return is not None else None,
            "volume_ratio": rounded(volume_ratio, 2),
            "phase": phase,
            "mode": mode,
            "match_age_bars": age_bars,
            "is_current": age_bars == 0,
            "pattern": [rounded(value, 4) for value in pattern],
            "candles": self._result_candles(series, chart_start, chart_end, start, end),
        }

    def _match_one(self, item: dict, query: np.ndarray, lookback: int) -> dict | None:
        series = self.cache.get(item["code"])
        if not series:
            return None
        close = series["close"]
        horizon = min(15, max(6, lookback // 3))
        searchable_close = close[:-horizon] if len(close) > horizon else close[:0]
        if len(searchable_close) < lookback:
            return None

        _, normalized, total_distance = self._score_windows(searchable_close, query, lookback)
        best_start = int(np.argmin(total_distance))
        best_end = best_start + lookback
        best_path = normalized[best_start]
        score = 100.0 * math.exp(-float(total_distance[best_start]) * 6.2)

        forward_index = min(len(close) - 1, best_end - 1 + horizon)
        forward_return = close[forward_index] / max(close[best_end - 1], 1e-8) - 1.0

        result = self._window_result(item, series, best_path, best_start, best_end, score, "history", len(close) - best_end, forward_return)
        result["priority_score"] = result["score"]
        return result

    def _match_current_one(self, item: dict, query: np.ndarray, lookback: int) -> dict | None:
        series = self.cache.get(item["code"])
        if not series or len(series["close"]) < lookback:
            return None
        close = series["close"]
        _, normalized, distances = self._score_windows(close, query, lookback)
        best_start = len(close) - lookback
        score = 100.0 * math.exp(-float(distances[-1]) * 6.2)
        result = self._window_result(item, series, normalized[-1], best_start, len(close), score, "current", 0)
        result["priority_score"] = result["score"]
        return result

    def _match_recent_one(self, item: dict, query: np.ndarray, lookback: int, recent_days: int) -> dict | None:
        series = self.cache.get(item["code"])
        if not series or len(series["close"]) < lookback:
            return None
        close = series["close"]
        _, normalized, distances = self._score_windows(close, query, lookback)
        first_start = max(0, len(close) - recent_days - lookback + 1)
        candidate_starts = range(first_start, len(close) - lookback + 1)
        half_life = max(1.0, recent_days * 0.45)
        best = None
        for start in candidate_starts:
            end = start + lookback
            age_bars = len(close) - end
            score = 100.0 * math.exp(-float(distances[start]) * 6.2)
            recency = math.exp(-age_bars / half_life)
            priority_score = score * (0.65 + 0.35 * recency)
            if best is None or priority_score > best[0]:
                best = (priority_score, start, end, age_bars, score)
        if best is None:
            return None
        priority_score, best_start, best_end, age_bars, score = best
        result = self._window_result(item, series, normalized[best_start], best_start, best_end, score, "recent", age_bars)
        result["priority_score"] = rounded(priority_score, 1)
        return result

    def match(self, points: list[float], lookback: int, group: str, mode: str = "current", recent_days: int = 20, limit: int = 24, compact: bool = False) -> dict:
        self.load_cache()
        lookback = max(5, min(int(lookback), 160))
        mode = mode if mode in {"current", "recent", "history"} else "current"
        recent_days = max(5, min(int(recent_days), 120))
        limit = max(1, min(int(limit), 100))
        raw_query = np.asarray(points, dtype=float)
        raw_query = np.clip(raw_query, 0.0, 1.0)
        if raw_query.size < 2:
            raw_query = np.asarray([0.42, 0.55, 0.38, 0.62, 0.5, 0.74], dtype=float)
        query = normalize_path(resample(raw_query, 48))[0]
        started = time.perf_counter()
        items = self.metadata if not group or group == "all" else [
            item for item in self.metadata if item["group"] == group
        ]
        results = []
        for item in items:
            if mode == "history":
                result = self._match_one(item, query, lookback)
            elif mode == "recent":
                result = self._match_recent_one(item, query, lookback, recent_days)
            else:
                result = self._match_current_one(item, query, lookback)
            if result:
                results.append(result)
        results.sort(key=lambda result: (result.get("priority_score", result["score"]), result["score"]), reverse=True)
        if mode in {"current", "recent"}:
            for result in results[:limit]:
                result["history_stats"] = self._history_stats(self.cache[result["code"]], query, lookback, recent_days)
        for rank, result in enumerate(results, start=1):
            result["rank"] = rank
        return {
            "query": [rounded(value, 4) for value in raw_query.tolist()],
            "lookback": lookback,
            "group": group or "all",
            "mode": mode,
            "recent_days": recent_days,
            "count": len(results),
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            "results": results[:limit],
            "returned_count": min(limit, len(results)),
            "overview": self.overview(),
        }


try:
    MARKET = MarketIndex(DATA_PATH)
    STARTUP_ERROR = None
except Exception as exc:  # pragma: no cover - gives the browser a useful error state
    MARKET = None
    STARTUP_ERROR = str(exc)


UPDATE_LOCK = threading.Lock()
UPDATE_JOB = {
    "status": "idle",
    "started_at": None,
    "ended_at": None,
    "exit_code": None,
    "detail": "尚未运行更新任务",
    "log": [],
}


def update_snapshot() -> dict:
    with UPDATE_LOCK:
        return {**UPDATE_JOB, "log": list(UPDATE_JOB["log"])}


def _append_update_log(line: str) -> None:
    clean = line.rstrip()
    if not clean:
        return
    with UPDATE_LOCK:
        UPDATE_JOB["log"].append(clean)
        UPDATE_JOB["log"] = UPDATE_JOB["log"][-80:]
        UPDATE_JOB["detail"] = clean


def _run_update_process(command: list[str]) -> None:
    global MARKET, STARTUP_ERROR
    process = None
    try:
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            _append_update_log(line)
        return_code = process.wait()
        if return_code == 0:
            if MARKET is None and DATA_PATH.exists():
                MARKET = MarketIndex(DATA_PATH)
                STARTUP_ERROR = None
            if MARKET is not None:
                MARKET.refresh_if_changed()
                latest = MARKET.overview().get("latest_date", "—")
            else:
                latest = "—"
            with UPDATE_LOCK:
                UPDATE_JOB["status"] = "success"
                UPDATE_JOB["exit_code"] = return_code
                UPDATE_JOB["ended_at"] = datetime.now().isoformat(timespec="seconds")
                UPDATE_JOB["detail"] = f"更新完成，最新数据 {latest}"
        else:
            with UPDATE_LOCK:
                UPDATE_JOB["status"] = "error"
                UPDATE_JOB["exit_code"] = return_code
                UPDATE_JOB["ended_at"] = datetime.now().isoformat(timespec="seconds")
                UPDATE_JOB["detail"] = f"更新脚本退出码 {return_code}"
    except Exception as exc:
        _append_update_log(f"[server] {exc}")
        with UPDATE_LOCK:
            UPDATE_JOB["status"] = "error"
            UPDATE_JOB["exit_code"] = -1
            UPDATE_JOB["ended_at"] = datetime.now().isoformat(timespec="seconds")
            UPDATE_JOB["detail"] = str(exc)


def start_update_job(start_date: str | None, end_date: str | None) -> dict:
    if not (os.getenv("TUSHARE_TOKEN") or os.getenv("TS_TOKEN")):
        raise RuntimeError("服务进程未配置 TUSHARE_TOKEN 或 TS_TOKEN")
    if not DATA_PATH.exists() and not start_date:
        raise RuntimeError("本地暂无行情数据，请先填写开始日期")
    with UPDATE_LOCK:
        if UPDATE_JOB["status"] == "running":
            raise RuntimeError("行情更新正在进行中")
        command = [sys.executable, str(ROOT / "tools" / "refresh_market_data.py")]
        if start_date:
            command.extend(["--start-date", start_date])
        if end_date:
            command.extend(["--end-date", end_date])
        UPDATE_JOB.clear()
        UPDATE_JOB.update({
            "status": "running",
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "ended_at": None,
            "exit_code": None,
            "detail": "正在启动行情更新…",
            "log": ["[server] 已启动行情更新任务"],
        })
    thread = threading.Thread(target=_run_update_process, args=(command,), daemon=True)
    thread.start()
    return update_snapshot()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "PatternMirror/1.0"

    def log_message(self, format_string: str, *args) -> None:
        if self.path.startswith("/api"):
            super().log_message(format_string, *args)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file() or ROOT not in path.resolve().parents:
            self._send_json({"error": "Not found"}, 404)
            return
        content = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({"ok": STARTUP_ERROR is None, "error": STARTUP_ERROR})
            return
        if parsed.path == "/api/update-status":
            overview = MARKET.overview() if MARKET is not None else {"latest_date": "", "data_lag_days": None}
            self._send_json({"ok": True, "job": update_snapshot(), "overview": overview})
            return
        if parsed.path == "/api/overview":
            if STARTUP_ERROR or MARKET is None:
                self._send_json({"ok": False, "error": STARTUP_ERROR}, 500)
                return
            self._send_json({"ok": True, **MARKET.overview()})
            return
        if parsed.path == "/api/universe":
            if STARTUP_ERROR or MARKET is None:
                self._send_json({"ok": False, "error": STARTUP_ERROR}, 500)
                return
            params = parse_qs(parsed.query)
            group = params.get("group", ["all"])[0]
            limit = int(params.get("limit", [100])[0])
            self._send_json({"ok": True, "items": MARKET.symbols(group, limit)})
            return
        if parsed.path == "/api/quotes":
            if STARTUP_ERROR or MARKET is None:
                self._send_json({"ok": False, "error": STARTUP_ERROR}, 500)
                return
            params = parse_qs(parsed.query)
            raw_codes = params.get("codes", [""])[0]
            codes = [code.strip().upper() for code in raw_codes.split(",") if code.strip()]
            self._send_json({"ok": True, "items": MARKET.quotes(codes), "overview": MARKET.overview()})
            return
        requested = parsed.path.lstrip("/") or "index.html"
        self._send_file((ROOT / requested).resolve())

    def do_POST(self) -> None:
        if self.path == "/api/update":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                start_date = body.get("start_date") or None
                end_date = body.get("end_date") or None
                for value in [start_date, end_date]:
                    if value:
                        date.fromisoformat(value)
                if start_date and end_date and date.fromisoformat(start_date) > date.fromisoformat(end_date):
                    raise ValueError("开始日期不能晚于结束日期")
                self._send_json({"ok": True, "job": start_update_job(start_date, end_date)}, 202)
            except RuntimeError as exc:
                self._send_json({"ok": False, "error": str(exc)}, 409)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
            return
        if self.path != "/api/match":
            self._send_json({"error": "Not found"}, 404)
            return
        if STARTUP_ERROR or MARKET is None:
            self._send_json({"ok": False, "error": STARTUP_ERROR}, 500)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            points = body.get("points", [])
            lookback = body.get("lookback", 40)
            group = body.get("group", "all")
            mode = body.get("mode", "current")
            recent_days = body.get("recent_days", 20)
            limit = body.get("limit", 24)
            compact = bool(body.get("compact", False))
            payload = MARKET.match(points, lookback, group, mode, recent_days, limit, compact)
            if compact:
                for result in payload["results"]:
                    result["candles"] = []
            self._send_json({"ok": True, **payload})
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, 400)


def main() -> None:
    parser = argparse.ArgumentParser(description="Pattern Mirror local data service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    print(f"Pattern Mirror running at http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
