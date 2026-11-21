#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 the q2-filebrowser authors (internal/LICENSE)
# From q2-filebrowser's contrib/shanlingq2/package.py (github.com/group-a-study/q2-filebrowser).
"""Ready a staged card folder for the Q2 and zip it as a release ships it.

    package.py STAGED_DIR ZIP

STAGED_DIR is dist/.eq-studio (the app q2-eq-studio, its launcher run, its manifest q2app, its
icons icon.png, 52 px, and icon-40.png, and the AutoEq catalogue presets.json.gz with its licence
AUTOEQ-LICENSE.txt). The app must be a static MIPS32 little-endian executable with soft-float ABI flags (GOMIPS=softfloat), so the
firmware's -mfp64 doesn't matter; the Q2's kernel still requires the nan2008 ELF flag, which Go
doesn't set, so it is set here, as q2-librespot's q2-link sets it for rustc's objects. Each entry is
dated 2026-01-01, so two builds of a commit are byte-identical; the App Store unpacks only the
.<id> folder, never a dot-underscore file."""
import pathlib, struct, sys, zipfile

EF_MIPS_NAN2008 = 0x400
PT_INTERP, PT_MIPS_ABIFLAGS = 3, 0x70000003
MIPS_FP_SOFT = 3
STAMP = (2026, 1, 1, 0, 0, 0)
FILES = ('q2app', 'icon.png', 'icon-40.png', 'presets.json.gz', 'AUTOEQ-LICENSE.txt', 'run')  # then the app, last


def fail(msg):
    raise SystemExit(f'package.py: {msg}')


def mark_q2(data):
    """data checked as a static MIPS32 little-endian executable with soft-float ABI flags, nan2008 set."""
    if data[:7] != b'\x7fELF\x01\x01\x01':
        fail('not a 32-bit little-endian ELF')
    e_type, e_machine = struct.unpack_from('<HH', data, 16)
    e_phoff, = struct.unpack_from('<I', data, 28)
    e_flags, = struct.unpack_from('<I', data, 36)
    e_phentsize, e_phnum = struct.unpack_from('<HH', data, 42)
    if e_type != 2 or e_machine != 8:
        fail('not a MIPS executable')
    fp = None
    for i in range(e_phnum):
        p_type, p_offset = struct.unpack_from('<II', data, e_phoff + i * e_phentsize)
        if p_type == PT_INTERP:
            fail("dynamically linked: the Q2 runs it without the build machine's libraries")
        if p_type == PT_MIPS_ABIFLAGS:
            fp = data[p_offset + 7]
    if fp != MIPS_FP_SOFT:
        fail(f'FP ABI {fp}, not soft float')
    struct.pack_into('<I', data, 36, e_flags | EF_MIPS_NAN2008)
    return data


def main():
    if len(sys.argv) != 3:
        fail('usage: package.py STAGED_DIR ZIP')
    staged, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    folder = staged.name
    app = staged/('q2-' + folder.lstrip('.'))
    app.write_bytes(mark_q2(bytearray(app.read_bytes())))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in FILES + (app.name,):
            info = zipfile.ZipInfo(f'{folder}/{name}', STAMP)
            info.external_attr = (0o100000 | (0o755 if name in ('run', app.name) else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (staged/name).read_bytes())
    print(out)


if __name__ == '__main__':
    main()
