"""饰品驿站助手登录态解析器：只读解析 5E 客户端 Local Storage 当前有效登录态。

用法：
  auth-reader --pipe <leveldb 目录>    由主进程以匿名管道调用；凭证只写入父进程继承的标准输出管道
  auth-reader --status <leveldb 目录>  只输出状态元数据，绝不输出凭证

规则（技术选型 §4）：只读来源 https://view-arena.5eplay.com 的 authorization；按 CURRENT 指向的
Manifest 重建有效 SST 集合与当前/前一日志；按记录序列号选最新值，删除或空值认定未登录且不恢复历史值；
解析前后比较文件集合，变化时最多重读 3 次。不写文件、不打开网络端口、不复制用户配置目录。
"""
from __future__ import annotations

import contextlib
import io
import json
import logging
import os
import pathlib
import re
import sys
import time

logging.disable(logging.CRITICAL)

ORIGIN = 'https://view-arena.5eplay.com'
KEY = 'authorization'
PROTOCOL_VERSION = 1


class AuthReadError(Exception):
    pass


def _leveldb():
    from ccl_chromium_reader.storage_formats import ccl_leveldb as leveldb
    from ccl_chromium_reader.ccl_chromium_localstorage import decode_string
    return leveldb, decode_string


def active_files(directory: pathlib.Path):
    leveldb, _ = _leveldb()
    current = (directory / 'CURRENT').read_text(encoding='ascii').strip()
    if not re.fullmatch(r'MANIFEST-\d+', current):
        raise AuthReadError('INVALID_MANIFEST')
    manifest = leveldb.ManifestFile(directory / current)
    live: set[int] = set()
    log_number = 0
    previous_log = 0
    try:
        for edit in manifest:
            live.difference_update(f.file_no for f in edit.deleted_files)
            live.update(f.file_no for f in edit.new_files)
            if edit.log_number is not None:
                log_number = edit.log_number
            if edit.prev_log_number is not None:
                previous_log = edit.prev_log_number
        if manifest.damage:
            raise AuthReadError('DAMAGED_MANIFEST')
    finally:
        manifest.close()
    selected = []
    for path in directory.iterdir():
        if path.suffix in ('.ldb', '.sst') and path.stem.isdigit() and int(path.stem) in live:
            selected.append(path)
        if path.suffix == '.log' and path.stem.isdigit() and (
            int(path.stem) >= log_number or int(path.stem) == previous_log
        ):
            selected.append(path)
    return [directory / 'CURRENT', directory / current], selected


def fingerprint(paths):
    return {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in paths}


def read_record(directory, origin=ORIGIN, key=KEY):
    """返回 (凭证或 None, 元数据)。目录不存在时抛出 NO_CLIENT。"""
    directory = pathlib.Path(directory)
    if not directory.is_dir():
        raise AuthReadError('NO_CLIENT')
    if not (directory / 'CURRENT').exists():
        return None, {'state': 'NO_LOGIN', 'reason': 'NO_DATABASE'}
    leveldb, decode_string = _leveldb()
    for attempt in range(3):
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                meta, files = active_files(directory)
                before = fingerprint(meta + files)
                candidates = []
                for path in files:
                    reader = leveldb.LogFile(path) if path.suffix == '.log' else leveldb.LdbFile(path)
                    try:
                        for record in reader:
                            raw = record.user_key
                            if not raw.startswith(b'_') or b'\x00' not in raw:
                                continue
                            raw_origin, raw_key = raw[1:].split(b'\x00', 1)
                            if raw_origin.decode('latin1') != origin or decode_string(raw_key) != key:
                                continue
                            live = record.state == leveldb.KeyState.Live
                            value = decode_string(record.value) if live else None
                            candidates.append((record.seq, live, value))
                        if getattr(reader, 'damage', []):
                            raise AuthReadError('DAMAGED_LOG')
                    finally:
                        reader.close()
                meta_after, files_after = active_files(directory)
                if before != fingerprint(meta_after + files_after):
                    raise AuthReadError('CONCURRENT_CHANGE')
                if not candidates:
                    return None, {'state': 'NO_LOGIN'}
                seq, live, value = max(candidates, key=lambda x: x[0])
                if not live or not value:
                    return None, {'state': 'NO_LOGIN'}
                return value, {'state': 'READ'}
        except (OSError, ValueError, AuthReadError, EOFError) as error:
            if isinstance(error, AuthReadError) and str(error) == 'NO_CLIENT':
                raise
            if attempt == 2:
                reason = str(error) if isinstance(error, AuthReadError) else type(error).__name__
                raise AuthReadError(f'READ_FAILED:{reason}') from None
            time.sleep(0.1)
    raise AuthReadError('READ_FAILED')


def run(argv, stdout) -> int:
    if len(argv) != 2 or argv[0] not in ('--pipe', '--status'):
        stdout.write(json.dumps({'v': PROTOCOL_VERSION, 'state': 'USAGE'}) + '\n')
        return 2
    mode, directory = argv
    if mode == '--pipe' and stdout.isatty():
        # 凭证只允许经父进程的匿名管道返回，拒绝输出到终端
        stdout.write(json.dumps({'v': PROTOCOL_VERSION, 'state': 'PIPE_REQUIRED'}) + '\n')
        return 3
    try:
        token, meta = read_record(directory)
    except AuthReadError as error:
        message = str(error)
        state = 'NO_CLIENT' if message == 'NO_CLIENT' else 'READ_FAILED'
        reason = message.split(':', 1)[1] if ':' in message else message
        stdout.write(json.dumps({'v': PROTOCOL_VERSION, 'state': state, 'reason': reason}) + '\n')
        return 0
    payload = {'v': PROTOCOL_VERSION, 'state': meta['state']}
    if mode == '--pipe' and token:
        payload['credential'] = token
    stdout.write(json.dumps(payload) + '\n')
    stdout.flush()
    return 0


def main() -> int:
    stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', newline='\n')
    try:
        return run(sys.argv[1:], stdout)
    finally:
        stdout.flush()


if __name__ == '__main__':
    raise SystemExit(main())
