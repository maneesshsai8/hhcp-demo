import sanitizeHtmlLib from 'sanitize-html';

/**
 * HTML sanitizer for announcement rich-text bodies. Port of
 * backend/app/sanitizer.py — same conservative allowlist, implemented with
 * `sanitize-html` (pure JS, no native deps) per analysis §5. Anything not
 * explicitly allowed is dropped; script/style/template content is discarded;
 * href/src must use a safe scheme; links that open a new tab get a safe rel.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'code', 'pre', 'span',
];

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    span: ['class'],
    code: ['class'],
    pre: ['class'],
  },
  // blocks javascript:, data:, vbscript: — mirrors _SAFE_URL_SCHEMES
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {},
  allowProtocolRelative: false,
  // discard disallowed tags but keep their text (matches the Python parser),
  // while dropping the *content* of script/style/template entirely.
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'template', 'textarea', 'noscript'],
  transformTags: {
    // force external links (target set) to be safe — mirrors the Python rule
    a: (tagName, attribs) => {
      if (attribs.target) {
        attribs.rel = 'noopener noreferrer nofollow';
      }
      return { tagName, attribs };
    },
  },
};

/** Return a sanitized copy of `html`, or null if the input was null/undefined. */
export function sanitizeHtml(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  return sanitizeHtmlLib(html, OPTIONS);
}
