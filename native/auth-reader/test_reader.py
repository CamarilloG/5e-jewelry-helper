"""人工构造 LevelDB 样例：最新值、删除、空值、UTF-16、来源隔离、淘汰日志、序列号优先、管道协议。
不读取任何真实用户目录。"""
import io
import json
import pathlib
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from reader import ORIGIN, AuthReadError, read_record, run  # noqa: E402


def varint(n):
    result = bytearray()
    while n >= 128:
        result.append((n & 127) | 128)
        n >>= 7
    result.append(n)
    return bytes(result)


def blob(value):
    return varint(len(value)) + value


def crc32c(data):
    crc = 0xffffffff
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    return crc ^ 0xffffffff


def block(data):
    crc = crc32c(b'\x01' + data)
    crc = ((crc >> 15) | (crc << 17)) & 0xffffffff
    crc = (crc + 0xa282ead8) & 0xffffffff
    return struct.pack('<IHB', crc, len(data), 1) + data


def make_log(path, changes, seq=1, origin=ORIGIN, utf16=False):
    key = b'_' + origin.encode() + b'\0\x01authorization'
    data = struct.pack('<QI', seq, len(changes))
    for value in changes:
        data += bytes([0 if value is None else 1]) + blob(key)
        if value is not None:
            data += blob(b'\x00' + value.encode('utf-16-le') if utf16 else b'\x01' + value.encode('latin1'))
    path.write_bytes(block(data))


class FakeStdout(io.StringIO):
    def __init__(self, tty=False):
        super().__init__()
        self._tty = tty

    def isatty(self):
        return self._tty


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.temp.name)
        (self.dir / 'CURRENT').write_text('MANIFEST-000001\n')
        (self.dir / 'MANIFEST-000001').write_bytes(block(b'\x02' + varint(2) + b'\x04' + varint(0)))

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in self.dir.iterdir()}

    def test_latest(self):
        make_log(self.dir / '000002.log', ['old', 'new'])
        self.assertEqual(read_record(self.dir)[0], 'new')

    def test_deletion_does_not_resurrect(self):
        make_log(self.dir / '000002.log', ['old', None])
        self.assertIsNone(read_record(self.dir)[0])

    def test_empty_value_logs_out(self):
        make_log(self.dir / '000002.log', ['old', ''])
        self.assertIsNone(read_record(self.dir)[0])

    def test_utf16(self):
        make_log(self.dir / '000002.log', ['中文模拟凭证'], utf16=True)
        self.assertEqual(read_record(self.dir)[0], '中文模拟凭证')

    def test_origin_isolation(self):
        make_log(self.dir / '000002.log', ['untrusted'], origin='https://example.invalid')
        self.assertIsNone(read_record(self.dir)[0])

    def test_obsolete_log_excluded(self):
        make_log(self.dir / '000001.log', ['stale'], seq=200)
        make_log(self.dir / '000002.log', ['current'], seq=1)
        self.assertEqual(read_record(self.dir)[0], 'current')

    def test_sequence_not_filename(self):
        make_log(self.dir / '000002.log', ['latest'], seq=300)
        make_log(self.dir / '000003.log', ['older'], seq=100)
        self.assertEqual(read_record(self.dir)[0], 'latest')

    def test_read_does_not_modify_directory(self):
        make_log(self.dir / '000002.log', ['value'])
        before = self.snapshot()
        read_record(self.dir)
        self.assertEqual(before, self.snapshot())

    def test_missing_directory_is_no_client(self):
        with self.assertRaises(AuthReadError) as ctx:
            read_record(self.dir / 'missing')
        self.assertEqual(str(ctx.exception), 'NO_CLIENT')

    def test_empty_database_is_no_login(self):
        empty = self.dir / 'empty'
        empty.mkdir()
        self.assertEqual(read_record(empty), (None, {'state': 'NO_LOGIN', 'reason': 'NO_DATABASE'}))

    def test_pipe_mode_returns_credential(self):
        make_log(self.dir / '000002.log', ['模拟'.encode('utf-8').decode('latin1')])
        out = FakeStdout()
        self.assertEqual(run(['--pipe', str(self.dir)], out), 0)
        payload = json.loads(out.getvalue())
        self.assertEqual(payload['state'], 'READ')
        self.assertIn('credential', payload)

    def test_pipe_mode_refuses_terminal(self):
        make_log(self.dir / '000002.log', ['secret-value'])
        out = FakeStdout(tty=True)
        self.assertEqual(run(['--pipe', str(self.dir)], out), 3)
        self.assertNotIn('secret-value', out.getvalue())

    def test_status_mode_never_prints_credential(self):
        make_log(self.dir / '000002.log', ['secret-value'])
        out = FakeStdout()
        run(['--status', str(self.dir)], out)
        self.assertNotIn('secret-value', out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['state'], 'READ')

    def test_no_client_state(self):
        out = FakeStdout()
        run(['--pipe', str(self.dir / 'nope')], out)
        self.assertEqual(json.loads(out.getvalue())['state'], 'NO_CLIENT')


if __name__ == '__main__':
    unittest.main(verbosity=2)
