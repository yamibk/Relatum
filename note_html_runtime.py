"""Offline HTML frames for the Windows notes workspace."""
from __future__ import annotations

import base64
import re
import secrets
import time
from dataclasses import dataclass


DOCUMENT_ORIGIN = 'https://relatum-html.invalid'
MINIMUM_WEBVIEW_MAJOR = 152

_HTML_SPACE = re.compile(rb'[\t\n\r\f ]*')
_HTML_PREFIX = tuple(re.compile(rb'<' + tag + rb'(?=[\t\n\r\f />])', re.IGNORECASE)
                     for tag in (b'!doctype', b'html', b'head'))
_TAG_DELIMITER = re.compile(rb"""[<>'"]""")
_SCROLLBAR_STYLE = b"""<style>
@layer relatum-embed-scrollbars {
  @media (forced-colors: none) {
    :where(*)::-webkit-scrollbar { width: 8px; height: 8px; }
    :where(*)::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
    :where(*)::-webkit-scrollbar-track, :where(*)::-webkit-scrollbar-corner { background: transparent; }
    :where(*)::-webkit-scrollbar-thumb { background: #85858a; border-radius: 8px; }
    :where(*)::-webkit-scrollbar-thumb:hover { background: #707075; }
  }
}
html { overscroll-behavior-x: contain; }
</style>"""


def _skip_html_prologue(content, offset):
    offset = _HTML_SPACE.match(content, offset).end()
    while content.startswith(b'<!--', offset):
        end = content.find(b'-->', offset + 4)
        if end < 0:
            return offset
        offset = _HTML_SPACE.match(content, end + 3).end()
    return offset


def _tag_end(content, offset):
    while match := _TAG_DELIMITER.search(content, offset):
        marker = match[0]
        if marker == b'>':
            return match.end()
        if marker == b'<':
            break
        closing = content.find(marker, match.end())
        if closing < 0:
            break
        offset = closing + 1
    return None


def style_embed_document(content: bytes) -> bytes:
    # Keep the BOM, document mode and explicit root/head attributes. Attach
    # before the first author style or script without reserializing the page.
    offset = 3 if content.startswith(b'\xef\xbb\xbf') else 0
    for pattern in _HTML_PREFIX:
        offset = _skip_html_prologue(content, offset)
        opener = pattern.match(content, offset)
        if opener:
            end = _tag_end(content, opener.end())
            if end is None:
                return content
            offset = end
    return content[:offset] + _SCROLLBAR_STYLE + content[offset:]


@dataclass
class _Document:
    html: bytes
    kind: str
    expires: float
    navigation_id: int | None = None


class NoteHtmlRuntime:
    """Serve one-use synthetic document URLs on the WebView's UI thread."""

    def __init__(self, backend, app_origin):
        from Microsoft.Web.WebView2.Core import (
            CoreWebView2PermissionState,
            CoreWebView2WebResourceContext,
            CoreWebView2WebResourceRequestSourceKinds,
        )
        from System import Convert
        from System.IO import MemoryStream

        self._native = backend.webview
        self._core = self._native.CoreWebView2
        self._backend = backend
        self._app_prefix = app_origin.rstrip('/') + '/'
        self._documents = {}
        self._probe_url = DOCUMENT_ORIGIN + '/check-' + secrets.token_urlsafe(24)
        self._resource_context = CoreWebView2WebResourceContext.Document
        self._source_kind = CoreWebView2WebResourceRequestSourceKinds.Document
        self._deny_permission = CoreWebView2PermissionState.Deny
        # Python.NET's sequence conversion boxes each byte on the UI thread.
        self._make_stream = lambda value: MemoryStream(Convert.FromBase64String(base64.b64encode(value).decode('ascii')))
        self._verified = False
        self._probe_reached = False
        self._probe_started = False

        version = self._core.Environment.BrowserVersionString.split('.', 1)[0]
        if not version.isdecimal() or int(version) < MINIMUM_WEBVIEW_MAJOR:
            raise RuntimeError('WebView2 does not support the HTML network policy')

        self._core.AddWebResourceRequestedFilter(
            DOCUMENT_ORIGIN + '/*', CoreWebView2WebResourceContext.All, self._source_kind,
        )
        self._core.WebResourceRequested += self._respond
        self._core.NavigationStarting += self._check_top_navigation
        self._core.LaunchingExternalUriScheme += self._check_external_launch
        self._core.FrameCreated += self._guard_frame
        self._native.WebMessageReceived -= backend.on_script_notify
        self._native.WebMessageReceived += self._trusted_message

    def _trusted_message(self, sender, args):
        if str(args.Source).startswith(self._app_prefix):
            self._backend.on_script_notify(sender, args)

    def _check_top_navigation(self, _sender, args):
        if str(args.Uri).startswith(DOCUMENT_ORIGIN + '/'):
            args.Cancel = True

    def _check_external_launch(self, _sender, args):
        origin = str(args.InitiatingOrigin)
        if origin == DOCUMENT_ORIGIN or origin.startswith(DOCUMENT_ORIGIN + '/'):
            args.Cancel = True

    def _guard_frame(self, _sender, args):
        frame = args.Frame
        protected = False

        def navigates(_frame, navigation):
            nonlocal protected
            url = str(navigation.Uri)
            if protected:
                navigation.Cancel = True
                return
            if not url.startswith(DOCUMENT_ORIGIN + '/'):
                return
            document = self._documents.get(url)
            if document is None or document.navigation_id is not None or document.expires <= time.monotonic():
                navigation.Cancel = True
                return
            document.navigation_id = navigation.NavigationId
            protected = True

        def permission(_frame, request):
            if protected:
                request.State = self._deny_permission
                request.Handled = True

        frame.NavigationStarting += navigates
        frame.PermissionRequested += permission

    def _respond(self, _sender, args):
        url = str(args.Request.Uri)
        # pywebview also registers a wildcard filter on this event. Requests
        # for the app itself must still reach its normal server and handlers.
        if not url.startswith(DOCUMENT_ORIGIN + '/'):
            return
        headers = 'Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n'
        status, reason, body = 404, 'Not Found', b''
        if args.Request.Method == 'GET':
            if url == self._probe_url and args.ResourceContext != self._resource_context:
                self._probe_reached = True
                status, reason, body = 200, 'OK', b'network-policy-unsupported'
                headers += 'Content-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\n'
            elif args.ResourceContext == self._resource_context:
                document = self._documents.pop(url, None)
                if document and document.navigation_id is not None and document.expires > time.monotonic():
                    status, reason, body = 200, 'OK', document.html
                    headers += self._document_headers(document.kind)
        args.Response = self._core.Environment.CreateWebResourceResponse(
            self._make_stream(body), status, reason, headers,
        )

    def _document_headers(self, kind):
        scripting = kind != 'static'
        sandbox = 'sandbox allow-scripts' if scripting else 'sandbox'
        scripts = "'unsafe-inline'" if scripting else "'none'"
        connect = DOCUMENT_ORIGIN if kind.startswith('probe') else "'none'"
        allowlist = '' if kind == 'probe-control' else 'Connection-Allowlist: ()\r\n'
        return (
            f'Content-Type: text/html; charset=utf-8\r\n{allowlist}'
            'X-DNS-Prefetch-Control: off\r\n'
            'Referrer-Policy: no-referrer\r\n'
            f'Content-Security-Policy: {sandbox}; default-src \'none\'; script-src {scripts}; '
            f"style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src {connect}; "
            "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; "
            f'frame-ancestors {self._app_prefix[:-1]}\r\n'
        )

    def _issue(self, content, kind):
        now = time.monotonic()
        self._documents = {url: doc for url, doc in self._documents.items() if doc.expires > now}
        if len(self._documents) >= 8:
            raise RuntimeError('Too many pending HTML frames')
        url = DOCUMENT_ORIGIN + '/document-' + secrets.token_urlsafe(24)
        self._documents[url] = _Document(content, kind, now + 15)
        return url

    def start_probe(self, control=False):
        # CSP permits this one synthetic request. A WebView without an enforced
        # Connection-Allowlist will reach the handler and receive a 200 response.
        script = f'''<!doctype html><script>
          (async () => {{
            let blocked = false;
            try {{ await fetch('{self._probe_url}', {{cache:'no-store'}}); }}
            catch {{ blocked = true; }}
            parent.postMessage({{noteHtmlProbe: blocked}}, '*');
          }})();
        </script>'''
        if not control and not self._probe_reached:
            raise RuntimeError('HTML network check could not reach its control endpoint')
        self._probe_reached = False
        self._probe_started = not control
        return self._issue(script.encode('utf-8'), 'probe-control' if control else 'probe')

    def confirm_probe(self):
        self._verified = self._probe_started and not self._probe_reached
        return self._verified

    @property
    def verified(self):
        return self._verified

    def revoke(self, url):
        if isinstance(url, str):
            self._documents.pop(url, None)

    def open_document(self, content, interactive):
        if not self._verified:
            raise RuntimeError('Offline HTML frame policy has not been verified')
        return self._issue(style_embed_document(content), 'active' if interactive else 'static')
