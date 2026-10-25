"""Static SVG intake and existing local files share one bounded validator."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import note_svg
from note_svg import SvgImageError, validate_svg
from notes_library import NotesError, NotesStore


def svg(body='', attributes='viewBox="0 0 400 200"'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" {attributes}>{body}</svg>'.encode('utf-8')


class NoteSvgTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='relatum-svg-')))
        self.store = NotesStore(self.root / 'notes')
        self.addCleanup(self.store.close)
        self.store.create('', 'Picture', 'note')

    def test_static_vectors_styles_internal_references_and_metadata(self):
        image = b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?>\n' + svg('''
            <sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" pagecolor="#ffffff"/>
            <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>drawing</rdf:Description></rdf:RDF></metadata>
            <style>.shape { fill: url("#gradient"); stroke: #123456; }</style>
            <defs><linearGradient id="gradient"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
            <path id="shape" d="M 0 0 H 400 V 200 Z"/></defs>
            <g class="shape"><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#shape"/></g>
            <text x="20" y="30">中文图形 &amp; text</text>''')
        uploaded = self.store.upload_image('Picture.md', '示意 (1).SVG', image, 'image/svg+xml; charset=UTF-8')
        target, media_type = self.store.resolve_image('Picture.md', uploaded['path'])
        self.assertEqual(media_type, 'image/svg+xml')
        self.assertEqual(target.read_bytes(), image, 'the original vector file is never rewritten or rasterized')
        self.assertEqual(self.store.upload_image('Picture.md', '示意 (1).SVG', image)['path'], uploaded['path'])
        self.assertIsNone(validate_svg(svg('<rect width="10" height="10"/>', 'width="10cm" height="5cm"')))

    def test_upload_import_and_existing_images_reject_the_same_unsafe_content(self):
        token = self.store.begin_import('')['token']
        bad_images = [
            b'not svg', b'<html/>', b'<svg/>', svg('<path>'),
            svg('<script>alert(1)</script>'), svg('<g onload="alert(1)"/>'),
            svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">web</div></foreignObject>'),
            svg('<animate attributeName="x" values="0;10" dur="1s" repeatCount="indefinite"/>'),
            svg('<use href="https://example.invalid/drawing.svg#shape"/>'),
            svg('<image href="data:image/png;base64,AAAA"/>'),
            svg('<g xml:base="https://example.invalid/"/>'),
            svg('<style>@import "https://example.invalid/style.css";</style>'),
            svg('<style>@keyframes pulse { to { opacity: 0; } }</style>'),
            svg('<path style="fill: url(https://example.invalid/paint.svg)"/>'),
            svg('<style>.a { fill: u/**/rl(//example.invalid/paint); }</style>'),
            svg(r'<style>.a { fill: u\72l(//example.invalid/paint); }</style>'),
            svg('<g style="animation: pulse 1s infinite"/>'),
            b'<?xml-stylesheet href="https://example.invalid/style.css"?>' + svg(),
            b'<?xml version="1.0" encoding="unknown-encoding"?>' + svg(),
            b'<!DOCTYPE svg [<!ENTITY x "expanded">]>' + svg('<text>&x;</text>'),
            svg(attributes='width="Infinity" height="10"'), svg(attributes='viewBox="0 0 NaN 10"'),
            svg(attributes='viewBox="0 0 -1 10"'),
            svg('<style>' + '/*' * 100_000 + '</style>'),
            svg('<style>' + 'url(' * 100_000 + '</style>'),
        ]
        for number, content in enumerate(bad_images):
            with self.subTest(number=number):
                existing = self.store.root / 'bad.svg'
                existing.write_bytes(content)
                operations = [
                    lambda: self.store.upload_image('Picture.md', 'bad.svg', content),
                    lambda: self.store.upload_import_file(token, 'bad.svg', content),
                    lambda: self.store.resolve_image('Picture.md', 'bad.svg'),
                ]
                for operation in operations:
                    with self.assertRaises(NotesError) as caught:
                        operation()
                    self.assertEqual((caught.exception.status, caught.exception.code), (400, 'invalid_image'))
                self.assertFalse((self.store.root / 'Picture.assets').exists(), 'reject before writing attachments')
                self.assertEqual(existing.read_bytes(), content, 'never rewrite existing user files')
        self.store.abort_import(token)

    def test_svg_budgets_and_dimensions_are_bounded(self):
        for content in (svg(attributes='width="32769" height="10"'),
                        svg(attributes='width="9000" height="9000"'), svg(attributes='width="1e99in"')):
            with self.subTest(content=content), self.assertRaises(NotesError) as caught:
                self.store.upload_image('Picture.md', 'large.svg', content)
            self.assertEqual(caught.exception.code, 'too_large')
        for name, budget, content in [
            ('MAX_SVG_BYTES', 30, svg()),
            ('MAX_SVG_ELEMENTS', 3, svg('<g/><g/><g/>')),
            ('MAX_SVG_DEPTH', 3, svg('<g><g><g/></g></g>')),
        ]:
            with self.subTest(name=name), mock.patch.object(note_svg, name, budget), self.assertRaises(SvgImageError) as caught:
                validate_svg(content)
            self.assertTrue(caught.exception.too_large)
        # Large viewBox coordinates alone are not huge pixel allocations.
        validate_svg(svg(attributes='width="400" height="200" viewBox="0 0 1000000 500000"'))

    def test_import_move_reference_cleanup_and_external_edit(self):
        image = svg('<rect width="400" height="200" fill="#78936c"/>')
        token = self.store.begin_import('')['token']
        self.store.upload_import_file(token, 'course/Note.md', b'![vector](drawing.svg)')
        self.store.upload_import_file(token, 'course/drawing.svg', image, 'image/svg+xml')
        self.store.commit_import(token)
        self.assertEqual(self.store.resolve_image('course/Note.md', 'drawing.svg')[0].read_bytes(), image)
        uploaded = self.store.upload_image('Picture.md', 'drawing.svg', image)
        note = self.store.load('Picture.md')
        self.store.save('Picture.md', f'![vector]({uploaded["path"]})', note['revision'])
        self.store.move('Picture.md', 'Moved.md')
        moved = self.store.load('Moved.md')
        source = moved['content'].split('](', 1)[1].rsplit(')', 1)[0]
        target, _ = self.store.resolve_image('Moved.md', source)
        self.assertEqual(target.read_bytes(), image)
        self.assertEqual(self.store.cleanup_unused_images('Moved.md', moved['revision'])['deletedCount'], 0)
        target.write_bytes(svg('<script>alert(1)</script>'))
        with self.assertRaises(NotesError):
            self.store.resolve_image('Moved.md', source)
        note = self.store.save('Moved.md', 'no image', moved['revision'])
        self.assertEqual(self.store.cleanup_unused_images('Moved.md', note['revision'])['deletedCount'], 1)


if __name__ == '__main__':
    unittest.main()
