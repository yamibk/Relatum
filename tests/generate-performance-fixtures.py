"""Generate isolated Relatum performance fixtures.

The destination must be a disposable Relatum runtime root. This script never
reads or writes the repository's real canvases/ or data/ directories.
"""

from __future__ import annotations

import argparse
import json
import struct
import zlib
from pathlib import Path
from typing import Optional


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def blank_pdf(page_count: int) -> bytes:
    objects: list[bytes] = []
    page_refs = " ".join(f"{index} 0 R" for index in range(3, 3 + page_count))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(
        f"<< /Type /Pages /Kids [{page_refs}] /Count {page_count} >>".encode()
    )
    content_id = 3 + page_count
    for _ in range(page_count):
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << >> /Contents {content_id} 0 R >>"
            ).encode()
        )
    objects.append(b"<< /Length 0 >>\nstream\n\nendstream")

    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode())
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode()
    )
    return bytes(output)


def png_chunk(kind: bytes, body: bytes) -> bytes:
    checksum = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", checksum)


def solid_png(width: int, height: int) -> bytes:
    row = b"\x00" + (b"\x5d\x82\xa8" * width)
    pixels = row * height
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(pixels, 9))
        + png_chunk(b"IEND", b"")
    )


def attachment_nodes(kind: str, count: int, asset: str) -> list[dict]:
    nodes = []
    for index in range(count):
        if index == 0:
            x, y = 120, 120
        else:
            x = 50_000 + (index - 1) * 10_000
            y = 120
        nodes.append(
            {
                "id": f"{kind}-{index}",
                "kind": kind,
                "name": f"{kind.upper()} fixture {index + 1}",
                "assetPath": asset,
                "x": x,
                "y": y,
                "width": 420,
                "height": 320,
            }
        )
    return nodes


def image_nodes(count: int) -> list[dict]:
    nodes = []
    for index in range(count):
        if index == 0:
            x, y = 120, 120
        else:
            slot = index - 1
            x = 50_000 + (slot % 10) * 6_000
            y = 120 + (slot // 10) * 6_000
        nodes.append(
            {
                "id": f"image-{index}",
                "kind": "image",
                "assetPath": f"images/large-{index:03d}.png",
                "x": x,
                "y": y,
                "width": 360,
                "height": 240,
            }
        )
    return nodes


def grid_nodes() -> list[dict]:
    nodes = []
    for index in range(1200):
        column = index % 40
        row = index // 40
        nodes.append(
            {
                "id": f"node-{index}",
                "text": f"Performance node {index}",
                "x": column * 240,
                "y": row * 110,
                "width": 180,
            }
        )
    return nodes


def dense_edges() -> list[dict]:
    edges = []
    edge_index = 0
    for row in range(30):
        for column in range(39):
            start = row * 40 + column
            edges.append(
                {
                    "id": f"edge-{edge_index}",
                    "from": f"node-{start}",
                    "to": f"node-{start + 1}",
                }
            )
            edge_index += 1
    for row in range(29):
        for column in range(40):
            start = row * 40 + column
            edges.append(
                {
                    "id": f"edge-{edge_index}",
                    "from": f"node-{start}",
                    "to": f"node-{start + 40}",
                }
            )
            edge_index += 1
    for row in range(29):
        start = row * 40
        edges.append(
            {
                "id": f"edge-{edge_index}",
                "from": f"node-{start}",
                "to": f"node-{start + 41}",
                "curve": "smooth",
            }
        )
        edge_index += 1
    assert len(edges) == 2359
    return edges


def canvas(nodes: list[dict], edges: Optional[list[dict]] = None) -> dict:
    return {
        "version": 2,
        "createdAt": "2026-07-29T00:00:00",
        "updatedAt": "2026-07-29T00:00:00",
        "nodes": nodes,
        "edges": edges or [],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime_root", type=Path)
    args = parser.parse_args()
    root = args.runtime_root.resolve()
    source_root = Path(__file__).resolve().parents[1]
    if root == source_root or source_root in root.parents or (root / ".git").exists():
        raise SystemExit(
            "Refusing to write performance fixtures into a source repository; "
            "pass a disposable isolated runtime directory."
        )
    canvases = root / "canvases"
    canvases.mkdir(parents=True, exist_ok=True)

    markdown_seed = (
        "## Isolated performance section\n\n"
        "This long local Markdown attachment exists only for Relatum performance testing. "
        "It contains headings, paragraphs, **strong text**, lists, and `inline code`.\n\n"
        "- first item\n- second item\n- third item\n\n"
    )
    markdown_target_bytes = 116 * 1024
    long_markdown = (
        markdown_seed * (markdown_target_bytes // len(markdown_seed.encode("utf-8")) + 1)
    )[:markdown_target_bytes]
    md_path = canvases / "perf-markdown.canvas"
    write_json(
        md_path,
        canvas(attachment_nodes("md", 40, "attachments/long.md")),
    )
    md_asset = canvases / "perf-markdown.assets" / "attachments" / "long.md"
    md_asset.parent.mkdir(parents=True, exist_ok=True)
    md_asset.write_bytes(long_markdown.encode("utf-8"))

    pdf_path = canvases / "perf-pdf.canvas"
    write_json(
        pdf_path,
        canvas(attachment_nodes("pdf", 12, "attachments/long.pdf")),
    )
    pdf_asset = canvases / "perf-pdf.assets" / "attachments" / "long.pdf"
    pdf_asset.parent.mkdir(parents=True, exist_ok=True)
    pdf_asset.write_bytes(blank_pdf(120))

    image_count = 80
    image_size = 1024
    image_path = canvases / "perf-images.canvas"
    write_json(image_path, canvas(image_nodes(image_count)))
    image_dir = canvases / "perf-images.assets" / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    image_bytes = solid_png(image_size, image_size)
    for index in range(image_count):
        (image_dir / f"large-{index:03d}.png").write_bytes(image_bytes)

    nodes = grid_nodes()
    write_json(canvases / "perf-nodes.canvas", canvas(nodes))
    write_json(canvases / "perf-edges.canvas", canvas(nodes, dense_edges()))
    large_nodes = [
        {"id": f"large-{i}", "text": f"性能节点 {i}", "kind": "card",
         "x": (i % 100) * 260, "y": (i // 100) * 140}
        for i in range(3000)
    ]
    large_edges = [
        {"id": f"large-edge-{i}", "from": f"large-{i}", "to": f"large-{i + 1}"}
        for i in range(3000) if i % 100 != 99
    ]
    write_json(canvases / "perf-3000.canvas", canvas(large_nodes, large_edges))
    write_json(canvases / "perf-interactions.canvas", canvas([
        {"id": "a", "kind": "card", "text": "保存", "x": 0, "y": 0},
        {"id": "b", "kind": "card", "text": "开始", "x": 360, "y": 0},
        {"id": "c", "kind": "index", "text": "目录", "x": 0, "y": 260},
        {"id": "d", "kind": "card", "text": "中文输入", "x": 360, "y": 260},
    ], [
        {"id": "under", "from": "a", "to": "b", "arrow": "end"},
        {"id": "over", "from": "a", "to": "b", "arrow": "end"},
        {"id": "curve", "from": "c", "to": "d", "curve": "smooth", "arrow": "both",
         "text": "曲线名称", "waypoints": [{"x": 150, "y": 170}, {"x": 280, "y": 420}]},
    ]))
    write_json(canvases / "perf-tree.canvas", canvas([
        {"id": "root", "kind": "index", "text": "路线目录", "x": 0, "y": 0},
        {"id": "child", "kind": "card", "text": "子节点", "x": 280, "y": 0},
        {"id": "branch", "kind": "card", "text": "分支", "x": 280, "y": 150},
        {"id": "leaf", "kind": "card", "text": "深层叶子", "x": 560, "y": 0},
        {"id": "group", "kind": "shape", "shapeType": "group-box", "text": "分组",
         "x": -20, "y": 280, "width": 540, "height": 160, "groupMemberIds": ["member"]},
        {"id": "member", "kind": "card", "text": "组员", "x": 40, "y": 330},
    ], [
        {"id": "rc", "from": "root", "to": "child", "arrow": "end"},
        {"id": "rb", "from": "root", "to": "branch", "arrow": "end"},
        {"id": "cl", "from": "child", "to": "leaf", "arrow": "end"},
    ]))

    viewport = {"scale": 1, "centerX": 330, "centerY": 280}
    write_json(
        root / "data" / "viewport.json",
        {
            "version": 1,
            "canvases": {
                "local:perf-markdown.canvas": viewport,
                "local:perf-pdf.canvas": viewport,
                "local:perf-images.canvas": viewport,
                "local:perf-nodes.canvas": viewport,
                "local:perf-edges.canvas": viewport,
                "local:perf-3000.canvas": viewport,
                "local:perf-interactions.canvas": viewport,
                "local:perf-tree.canvas": viewport,
            },
        },
    )

    print(
        json.dumps(
            {
                "root": str(root),
                "markdownBytes": md_asset.stat().st_size,
                "pdfPages": 120,
                "images": image_count,
                "imageDimensions": [image_size, image_size],
                "nodes": 1200,
                "edges": 2359,
                "largeNodes": 3000,
                "largeEdges": len(large_edges),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
