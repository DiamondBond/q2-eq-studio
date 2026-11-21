#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Diamond Bond
"""Draws card/icon.png (52 px) and card/icon-40.png: three EQ sliders in white on a flat indigo
rounded square. Each size is laid out on its own pixel grid, drawn 8 times over and boxed down, so
the tracks fall on whole pixels and only the curves are smoothed.

    python3 tools/icons.py"""
import pathlib
from PIL import Image, ImageDraw

S = 8  # drawn this many times over, then boxed down
FILL = (91, 91, 214, 255)
TRACK = (181, 181, 236, 255)  # white at 55% on FILL
KNOB = (255, 255, 255, 255)


def icon(size):
    im = Image.new('RGBA', (size * S, size * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, 'RGBA')
    d.rounded_rectangle((0, 0, size * S - 1, size * S - 1), radius=round(size * 0.22) * S, fill=FILL)
    step = round(size * 0.24)  # 12 px at 52, 10 at 40
    top, bottom = round(size * 0.23), size - round(size * 0.23)
    knob = round(size * 0.1)  # its radius
    for i, at in enumerate((0.62, 0.3, 0.5)):  # how far down each knob sits
        x = size // 2 + (i - 1) * step
        d.rectangle((((x - 1) * S, top * S), ((x + 1) * S - 1, bottom * S - 1)), fill=TRACK)
        y = round(top + knob + at * (bottom - top - 2 * knob))
        d.ellipse(((x - knob) * S, (y - knob) * S, (x + knob) * S - 1, (y + knob) * S - 1), fill=KNOB)
    return im.resize((size, size), Image.Resampling.BOX)


card = pathlib.Path(__file__).resolve().parent.parent / 'card'
icon(52).save(card / 'icon.png', optimize=True)
icon(40).save(card / 'icon-40.png', optimize=True)
