"""Incrementally refresh the local daily market parquet with TuShare.

The updater intentionally uses the full-market daily endpoint one open day at
a time:

    trade_cal(is_open=1) -> daily(trade_date=YYYYMMDD)

The output schema stays compatible with server.py:
trade_date, stock_code, open, high, low, close, volume, amount.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import os
import shutil
import sys
import tempfile
import time
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path
import zlib

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None
    import msvcrt


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from config import ConfigError, load_credentials

DATA_PATH = ROOT / "data" / "stock_daily.parquet"
STAGING_PREFIX = "stock_daily.update."
STAGING_PARTITIONS = 64
SCHEMA = pa.schema([
    ("trade_date", pa.timestamp("ns")),
    ("stock_code", pa.string()),
    ("open", pa.float64()),
    ("high", pa.float64()),
    ("low", pa.float64()),
    ("close", pa.float64()),
    ("volume", pa.float64()),
    ("amount", pa.float64()),
])


def compact_date(value: date | datetime | str) -> str:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    return str(value).replace("-", "")[:8]


def parse_date(value: str) -> date:
    normalized = str(value).replace("-", "")
    return datetime.strptime(normalized, "%Y%m%d").date()


def resolve_token() -> str:
    try:
        token = load_credentials().tushare_token
    except ConfigError as exc:
        raise RuntimeError(str(exc)) from exc
    if not token:
        raise RuntimeError("请在 config.ini [credentials] 中填写 tushare_token")
    return token


def latest_local_date() -> date | None:
    if not DATA_PATH.exists():
        return None
    parquet = pq.ParquetFile(DATA_PATH)
    dates = []
    for index in range(parquet.num_row_groups):
        stats = parquet.metadata.row_group(index).column(0).statistics
        if stats and stats.max:
            dates.append(pd.Timestamp(stats.max).date())
    return max(dates) if dates else None


def fetch_open_dates(pro, start_date: date, end_date: date, exchange: str) -> list[str]:
    calendar = pro.trade_cal(
        exchange=exchange,
        start_date=compact_date(start_date),
        end_date=compact_date(end_date),
        is_open=1,
        fields="cal_date,is_open",
    )
    if calendar is None or calendar.empty or "cal_date" not in calendar.columns:
        return []
    calendar = calendar.copy()
    calendar["cal_date"] = pd.to_datetime(calendar["cal_date"], format="%Y%m%d", errors="coerce")
    calendar = calendar.dropna(subset=["cal_date"]).sort_values("cal_date")
    return [value.strftime("%Y%m%d") for value in calendar["cal_date"]]


def normalize_daily(frame: pd.DataFrame, trade_date: str) -> pd.DataFrame:
    if frame is None or frame.empty:
        return pd.DataFrame(columns=SCHEMA.names)
    required = {"ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"}
    missing = required.difference(frame.columns)
    if missing:
        raise RuntimeError(f"TuShare daily response is missing columns: {sorted(missing)}")
    result = frame[["trade_date", "ts_code", "open", "high", "low", "close", "vol", "amount"]].copy()
    result = result.rename(columns={"ts_code": "stock_code", "vol": "volume"})
    result["trade_date"] = pd.to_datetime(result["trade_date"], format="%Y%m%d", errors="coerce")
    result["trade_date"] = result["trade_date"].fillna(pd.Timestamp(parse_date(trade_date)))
    result["stock_code"] = result["stock_code"].astype(str)
    for column in ["open", "high", "low", "close", "volume", "amount"]:
        result[column] = pd.to_numeric(result[column], errors="coerce").astype(float)
    result = result.dropna(subset=["stock_code", "close"])
    return result[SCHEMA.names].sort_values(["stock_code", "trade_date"])


def _fetch_update_batch(
    pro,
    batch_dates: list[str],
    start_index: int,
    total_count: int,
    sleep_seconds: float,
) -> pd.DataFrame:
    frames = []
    for index, trade_date in enumerate(batch_dates, start=start_index):
        print(f"[{index}/{total_count}] daily {trade_date}", flush=True)
        frame = pro.daily(trade_date=trade_date)
        normalized = normalize_daily(frame, trade_date)
        if not normalized.empty:
            frames.append(normalized)
            print(f"  received {len(normalized):,} rows", flush=True)
        else:
            print("  no rows", flush=True)
        if sleep_seconds > 0 and index < total_count:
            time.sleep(sleep_seconds)
    if not frames:
        return pd.DataFrame(columns=SCHEMA.names)
    return pd.concat(frames, ignore_index=True).drop_duplicates(["stock_code", "trade_date"], keep="last")


def fetch_update_batches(
    pro,
    open_dates: list[str],
    sleep_seconds: float,
    batch_size: int,
) -> Iterator[pd.DataFrame]:
    """Yield bounded update frames so multi-year refreshes do not fill RAM."""
    total = len(open_dates)
    for batch_start in range(0, total, batch_size):
        batch_end = min(batch_start + batch_size, total)
        yield _fetch_update_batch(
            pro,
            open_dates[batch_start:batch_end],
            start_index=batch_start + 1,
            total_count=total,
            sleep_seconds=sleep_seconds,
        )


def table_from_frame(frame: pd.DataFrame) -> pa.Table:
    frame = frame[SCHEMA.names].copy()
    frame["trade_date"] = pd.to_datetime(frame["trade_date"])
    return pa.Table.from_pandas(frame, schema=SCHEMA, preserve_index=False, safe=False)


@contextmanager
def data_file_lock():
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_path = DATA_PATH.with_name(f"{DATA_PATH.name}.lock")
    with lock_path.open("a+") as lock:
        if fcntl is not None:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        else:
            lock.seek(0)
            lock.write("0")
            lock.flush()
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            else:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def _merge_to_parquet_locked(updates: pd.DataFrame) -> tuple[int, int]:
    if updates.empty:
        return 0, 0
    updates = updates.copy()
    updates["trade_date"] = pd.to_datetime(updates["trade_date"], errors="coerce")
    updates = updates.dropna(subset=["trade_date"])
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    update_by_code: dict[str, pd.DataFrame] = {
        code: group.sort_values("trade_date")
        for code, group in updates.groupby("stock_code", sort=False)
    }
    fd, temp_name = tempfile.mkstemp(prefix="stock_daily.", suffix=".parquet.tmp", dir=DATA_PATH.parent)
    os.close(fd)
    rows_written = 0
    row_groups_written = 0
    try:
        writer = pq.ParquetWriter(temp_name, SCHEMA, compression="zstd")
        source = None
        try:
            if DATA_PATH.exists():
                source = pq.ParquetFile(DATA_PATH)
                for row_group_index in range(source.num_row_groups):
                    existing = source.read_row_group(row_group_index).to_pandas()
                    if existing.empty:
                        continue
                    code = str(existing["stock_code"].iloc[0])
                    incoming = update_by_code.pop(code, None)
                    if incoming is not None:
                        combined = pd.concat([existing, incoming], ignore_index=True)
                        combined = combined.drop_duplicates(["stock_code", "trade_date"], keep="last")
                        combined = combined.sort_values(["stock_code", "trade_date"])
                    else:
                        combined = existing.sort_values(["stock_code", "trade_date"])
                    writer.write_table(table_from_frame(combined))
                    rows_written += len(combined)
                    row_groups_written += 1
            for code in sorted(update_by_code):
                new_rows = update_by_code[code].drop_duplicates(["stock_code", "trade_date"], keep="last")
                new_rows = new_rows.sort_values(["stock_code", "trade_date"])
                writer.write_table(table_from_frame(new_rows))
                rows_written += len(new_rows)
                row_groups_written += 1
        finally:
            if source is not None:
                source.close()
            writer.close()
        os.replace(temp_name, DATA_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return rows_written, row_groups_written


def merge_to_parquet(updates: pd.DataFrame) -> tuple[int, int]:
    if updates.empty:
        return 0, 0
    with data_file_lock():
        return _merge_to_parquet_locked(updates)


def _partition_number(code: str) -> int:
    return zlib.crc32(code.encode("utf-8")) % STAGING_PARTITIONS


def _partition_path(staging_dir: Path, prefix: str, partition: int) -> Path:
    return staging_dir / f"{prefix}-{partition:03d}.parquet"


def _close_partition_writers(writers: dict[int, pq.ParquetWriter]) -> None:
    for writer in writers.values():
        writer.close()
    writers.clear()


def _write_partitioned_frame(
    frame: pd.DataFrame,
    staging_dir: Path,
    prefix: str,
    writers: dict[int, pq.ParquetWriter],
) -> None:
    if frame.empty:
        return
    partitioned = frame[SCHEMA.names].copy()
    partitioned["_partition"] = partitioned["stock_code"].map(
        lambda value: _partition_number(str(value))
    )
    for partition, grouped in partitioned.groupby("_partition", sort=False):
        partition = int(partition)
        grouped = grouped.drop(columns="_partition")
        grouped = grouped.sort_values(["stock_code", "trade_date"])
        writer = writers.get(partition)
        if writer is None:
            writer = pq.ParquetWriter(
                str(_partition_path(staging_dir, prefix, partition)),
                SCHEMA,
                compression="zstd",
            )
            writers[partition] = writer
        writer.write_table(table_from_frame(grouped))


def _stage_update_batches(
    pro,
    open_dates: list[str],
    sleep_seconds: float,
    batch_size: int,
    staging_dir: Path,
) -> tuple[int, int]:
    writers: dict[int, pq.ParquetWriter] = {}
    updated_rows = 0
    batch_count = 0
    try:
        for batch_count, updates in enumerate(
            fetch_update_batches(pro, open_dates, sleep_seconds, batch_size),
            start=1,
        ):
            if updates.empty:
                print(f"Batch {batch_count}: no rows to stage", flush=True)
            else:
                _write_partitioned_frame(updates, staging_dir, "updates", writers)
                updated_rows += len(updates)
                print(f"Batch {batch_count}: staged {len(updates):,} rows", flush=True)
            del updates
    finally:
        _close_partition_writers(writers)
    return updated_rows, batch_count


def _stage_existing_data(staging_dir: Path) -> None:
    if not DATA_PATH.exists():
        return
    writers: dict[int, pq.ParquetWriter] = {}
    source = pq.ParquetFile(DATA_PATH)
    try:
        for row_group_index in range(source.num_row_groups):
            existing = source.read_row_group(row_group_index).to_pandas()
            _write_partitioned_frame(existing, staging_dir, "existing", writers)
    finally:
        source.close()
        _close_partition_writers(writers)


def _read_staged_partition(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    return pq.read_table(str(path), use_threads=False).to_pandas()


def _finalize_staged_update(staging_dir: Path) -> tuple[int, int]:
    fd, temp_name = tempfile.mkstemp(
        prefix="stock_daily.",
        suffix=".parquet.tmp",
        dir=DATA_PATH.parent,
    )
    os.close(fd)
    writer = None
    rows_written = 0
    row_groups_written = 0
    try:
        writer = pq.ParquetWriter(temp_name, SCHEMA, compression="zstd")
        for partition in range(STAGING_PARTITIONS):
            existing = _read_staged_partition(_partition_path(staging_dir, "existing", partition))
            updates = _read_staged_partition(_partition_path(staging_dir, "updates", partition))
            if existing is None and updates is None:
                continue
            if existing is None:
                combined = updates
            elif updates is None:
                combined = existing
            else:
                combined = pd.concat([existing, updates], ignore_index=True)
            assert combined is not None
            combined["trade_date"] = pd.to_datetime(combined["trade_date"], errors="coerce")
            combined = combined.dropna(subset=["trade_date"])
            combined = combined.drop_duplicates(
                ["stock_code", "trade_date"],
                keep="last",
            ).sort_values(["stock_code", "trade_date"])
            for _, group in combined.groupby("stock_code", sort=True):
                writer.write_table(table_from_frame(group))
                rows_written += len(group)
                row_groups_written += 1
            if partition % 8 == 7 or partition == STAGING_PARTITIONS - 1:
                print(
                    f"Merging staged data [{partition + 1}/{STAGING_PARTITIONS}]",
                    flush=True,
                )
            del existing, updates, combined
        writer.close()
        writer = None
        if rows_written:
            os.replace(temp_name, DATA_PATH)
    finally:
        if writer is not None:
            writer.close()
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return rows_written, row_groups_written


def _new_staging_directory() -> Path:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    for path in DATA_PATH.parent.glob(f"{STAGING_PREFIX}*"):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=DATA_PATH.parent))


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh data/stock_daily.parquet from TuShare daily")
    parser.add_argument("--start-date", help="inclusive YYYYMMDD or YYYY-MM-DD; defaults to the local latest date")
    parser.add_argument("--end-date", help="inclusive YYYYMMDD or YYYY-MM-DD; defaults to today")
    parser.add_argument("--exchange", default="SSE", help="trade calendar exchange, default SSE")
    parser.add_argument("--sleep-seconds", type=float, default=0.2, help="pause between daily API calls")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=20,
        help="number of trading days fetched and merged at a time, default 20",
    )
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-size 必须是正整数")

    token = resolve_token()
    try:
        import tushare as ts
    except ImportError as exc:
        raise RuntimeError("tushare is required: python -m pip install tushare") from exc
    ts.set_token(token)
    pro = ts.pro_api(token)

    updated_rows = 0
    rows_written = 0
    row_groups = 0
    with data_file_lock():
        local_latest = latest_local_date()
        if not args.start_date and local_latest is None:
            parser.error("本地暂无行情数据，首次初始化必须填写 --start-date")
        start_date = parse_date(args.start_date) if args.start_date else local_latest
        end_date = parse_date(args.end_date) if args.end_date else date.today()
        if start_date > end_date:
            print(f"No update needed: {start_date} is after {end_date}", flush=True)
            return 0

        print(f"Local latest: {local_latest or 'none'}", flush=True)
        print(f"Calendar range: {start_date} -> {end_date}", flush=True)
        open_dates = fetch_open_dates(pro, start_date, end_date, args.exchange)
        print(f"Open trading days: {len(open_dates)}", flush=True)
        staging_dir = _new_staging_directory()
        try:
            updated_rows, _ = _stage_update_batches(
                pro,
                open_dates,
                max(0.0, args.sleep_seconds),
                args.batch_size,
                staging_dir,
            )
            if updated_rows:
                print("Staging existing data before the final merge", flush=True)
                _stage_existing_data(staging_dir)
                print("Merging staged data", flush=True)
                rows_written, row_groups = _finalize_staged_update(staging_dir)
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)
    print(f"Updated {updated_rows:,} rows; wrote {rows_written:,} rows in {row_groups:,} row groups", flush=True)
    print(f"Output: {DATA_PATH}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
