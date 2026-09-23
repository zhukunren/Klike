"""Incrementally refresh the local daily market parquet with TuShare.

The updater intentionally uses the full-market daily endpoint one open day at
a time:

    trade_cal(is_open=1) -> daily(trade_date=YYYYMMDD)

The output schema stays compatible with server.py:
trade_date, stock_code, open, high, low, close, volume, amount.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "stock_daily.parquet"
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


def resolve_token(cli_token: str | None) -> str:
    token = cli_token or os.getenv("TUSHARE_TOKEN") or os.getenv("TS_TOKEN")
    if not token:
        raise RuntimeError("Missing TuShare token. Set TUSHARE_TOKEN or TS_TOKEN, or pass --token.")
    return token.strip()


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


def fetch_updates(pro, open_dates: list[str], sleep_seconds: float) -> pd.DataFrame:
    frames = []
    total = len(open_dates)
    for index, trade_date in enumerate(open_dates, start=1):
        print(f"[{index}/{total}] daily {trade_date}", flush=True)
        frame = pro.daily(trade_date=trade_date)
        normalized = normalize_daily(frame, trade_date)
        if not normalized.empty:
            frames.append(normalized)
            print(f"  received {len(normalized):,} rows", flush=True)
        else:
            print("  no rows", flush=True)
        if sleep_seconds > 0 and index < total:
            time.sleep(sleep_seconds)
    if not frames:
        return pd.DataFrame(columns=SCHEMA.names)
    return pd.concat(frames, ignore_index=True).drop_duplicates(["stock_code", "trade_date"], keep="last")


def table_from_frame(frame: pd.DataFrame) -> pa.Table:
    frame = frame[SCHEMA.names].copy()
    frame["trade_date"] = pd.to_datetime(frame["trade_date"])
    return pa.Table.from_pandas(frame, schema=SCHEMA, preserve_index=False, safe=False)


def merge_to_parquet(updates: pd.DataFrame) -> tuple[int, int]:
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
    existing_codes: set[str] = set()
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
                    existing_codes.add(code)
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh data/stock_daily.parquet from TuShare daily")
    parser.add_argument("--start-date", help="inclusive YYYYMMDD or YYYY-MM-DD; defaults to the local latest date")
    parser.add_argument("--end-date", help="inclusive YYYYMMDD or YYYY-MM-DD; defaults to today")
    parser.add_argument("--exchange", default="SSE", help="trade calendar exchange, default SSE")
    parser.add_argument("--sleep-seconds", type=float, default=0.2, help="pause between daily API calls")
    parser.add_argument("--token", help="TuShare token; TUSHARE_TOKEN/TS_TOKEN is preferred")
    args = parser.parse_args()

    token = resolve_token(args.token)
    try:
        import tushare as ts
    except ImportError as exc:
        raise RuntimeError("tushare is required: python -m pip install tushare") from exc
    ts.set_token(token)
    pro = ts.pro_api(token)

    local_latest = latest_local_date()
    start_date = parse_date(args.start_date) if args.start_date else local_latest or date(1990, 1, 1)
    end_date = parse_date(args.end_date) if args.end_date else date.today()
    if start_date > end_date:
        print(f"No update needed: {start_date} is after {end_date}", flush=True)
        return 0

    print(f"Local latest: {local_latest or 'none'}", flush=True)
    print(f"Calendar range: {start_date} -> {end_date}", flush=True)
    open_dates = fetch_open_dates(pro, start_date, end_date, args.exchange)
    print(f"Open trading days: {len(open_dates)}", flush=True)
    updates = fetch_updates(pro, open_dates, max(0.0, args.sleep_seconds))
    rows_written, row_groups = merge_to_parquet(updates)
    print(f"Updated {len(updates):,} rows; wrote {rows_written:,} rows in {row_groups:,} row groups", flush=True)
    print(f"Output: {DATA_PATH}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
