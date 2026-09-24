from __future__ import annotations

from configparser import ConfigParser, NoOptionError, NoSectionError
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.ini"


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credentials:
    tushare_token: str
    update_token: str


def load_credentials() -> Credentials:
    if not CONFIG_PATH.is_file():
        raise ConfigError(f"缺少配置文件: {CONFIG_PATH}")
    parser = ConfigParser()
    parser.read(CONFIG_PATH, encoding="utf-8")
    try:
        tushare_token = parser.get("credentials", "tushare_token").strip()
        update_token = parser.get("credentials", "update_token").strip()
    except (NoSectionError, NoOptionError) as exc:
        raise ConfigError("config.ini 必须包含 [credentials] 的 tushare_token 和 update_token") from exc
    return Credentials(tushare_token=tushare_token, update_token=update_token)
