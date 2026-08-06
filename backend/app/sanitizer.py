"""
Dependency-free HTML sanitizer for announcement rich-text bodies.

Announcements accept rich text (docs/ANNOUNCEMENTS-ARCHITECTURE.md §1 D). Rather
than pull in a native dependency (nh3/bleach) that may not install in every
environment, this is a conservative *allowlist* sanitizer built on the stdlib
`html.parser`: anything not explicitly allowed is dropped. It is deliberately
strict — a demo-grade defense that prevents stored XSS by removing scripts,
event handlers, and dangerous URL schemes.

Contract:
  * Only allowlisted tags survive; everything else has its tags stripped (text
    kept). Disallowed *content* tags (script/style) have their text dropped too.
  * Only allowlisted attributes survive; `href`/`src` must use a safe scheme.
  * Output is always well-formed (open tags are auto-closed at end).

For production you would swap this for nh3 (Rust ammonia) with the same
allowlist — the call site (`sanitize_html`) does not change.
"""
from html.parser import HTMLParser
from html import escape

# Inline + basic block formatting a headline post needs. No forms, no media
# embeds that execute, no iframes.
_ALLOWED_TAGS = {
    "p", "br", "strong", "b", "em", "i", "u", "s", "blockquote",
    "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "code", "pre", "span",
}
# Tags whose *text content* should also be discarded, not just the tags.
_DROP_CONTENT_TAGS = {"script", "style", "template"}

_ALLOWED_ATTRS = {
    "a": {"href", "title", "rel", "target"},
    "span": {"class"},
    "code": {"class"},
    "pre": {"class"},
}
_VOID_TAGS = {"br"}
_SAFE_URL_SCHEMES = {"http", "https", "mailto"}


def _safe_url(value: str) -> bool:
    v = (value or "").strip().lower()
    if v.startswith("/") or v.startswith("#"):
        return True                       # relative / anchor
    if ":" not in v:
        return True                       # scheme-less relative
    scheme = v.split(":", 1)[0]
    return scheme in _SAFE_URL_SCHEMES     # blocks javascript:, data:, vbscript:


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._open: list[str] = []         # stack of emitted (allowed) tags
        self._suppress_depth = 0           # inside a drop-content tag

    def handle_starttag(self, tag, attrs):
        if tag in _DROP_CONTENT_TAGS:
            self._suppress_depth += 1
            return
        if self._suppress_depth or tag not in _ALLOWED_TAGS:
            return
        kept = []
        for name, val in attrs:
            if name not in _ALLOWED_ATTRS.get(tag, set()):
                continue
            if name in ("href", "src") and not _safe_url(val or ""):
                continue
            kept.append((name, val))
        # force external links to be safe
        if tag == "a":
            attr_names = {n for n, _ in kept}
            if "target" in attr_names:
                kept = [kv for kv in kept if kv[0] != "rel"]
                kept.append(("rel", "noopener noreferrer nofollow"))
        attr_str = "".join(
            f' {n}="{escape(v or "", quote=True)}"' for n, v in kept
        )
        if tag in _VOID_TAGS:
            self.out.append(f"<{tag}{attr_str}/>")
        else:
            self.out.append(f"<{tag}{attr_str}>")
            self._open.append(tag)

    def handle_endtag(self, tag):
        if tag in _DROP_CONTENT_TAGS:
            if self._suppress_depth:
                self._suppress_depth -= 1
            return
        if self._suppress_depth or tag not in _ALLOWED_TAGS or tag in _VOID_TAGS:
            return
        # close down to the matching open tag (auto-closes any nested unclosed)
        if tag in self._open:
            while self._open:
                top = self._open.pop()
                self.out.append(f"</{top}>")
                if top == tag:
                    break

    def handle_data(self, data):
        if self._suppress_depth:
            return
        self.out.append(escape(data))

    def result(self) -> str:
        while self._open:
            self.out.append(f"</{self._open.pop()}>")
        return "".join(self.out)


def sanitize_html(html: str | None) -> str | None:
    """Return a sanitized copy of `html`, or None if the input was None."""
    if html is None:
        return None
    parser = _Sanitizer()
    parser.feed(html)
    parser.close()
    return parser.result()
