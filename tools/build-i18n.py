#!/usr/bin/env python3
"""Render the localized static site from templates/ + i18n/ into site/.

The output is committed to the repository, so nothing downstream (Docker,
nginx, the GitHub Pages workflow) needs a build step: they all just copy
site/. Run `make i18n` after editing anything under templates/ or i18n/ --
and after editing site/js/ or site/css/ by hand, because the service worker
(site/sw.js) carries a hash of every file it precaches. CI fails if the
committed output is stale.

Templating is deliberately minimal: {{key}} is HTML-escaped substitution,
{{{key}}} is raw. There are no loops -- repeated markup (sections, lists,
hreflang tags, navigation) is assembled here in Python.
"""

import hashlib
import html
import json
import pathlib
import re
import sys
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"
I18N = ROOT / "i18n"
SITE = ROOT / "site"

ORIGIN = "https://scanpdf.io"

# Order of the hreflang cluster and the sitemap; the language menu sorts itself
# by native name (see menu_order). English is the default locale, at the root.
LANGS = ["en", "es", "de", "pt", "fr", "it", "tr", "id", "hi"]
DEFAULT_LANG = "en"

# Page ids in navigation order. "home" is the scanner app itself.
PAGES = ["home", "guide", "faq", "privacy"]
CONTENT_PAGES = ["guide", "faq", "privacy"]


# --------------------------------------------------------------------------
# Templating
# --------------------------------------------------------------------------

TOKEN_RE = re.compile(r"\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}")


def render(template, ctx):
    """Substitute {{key}} (escaped) and {{{key}}} (raw). Unknown key -> error."""

    def replace(match):
        raw_key, esc_key = match.group(1), match.group(2)
        key = raw_key or esc_key
        if key not in ctx:
            raise KeyError(f"missing template variable: {key}")
        value = ctx[key]
        return value if raw_key else html.escape(str(value), quote=True)

    return TOKEN_RE.sub(replace, template)


# --------------------------------------------------------------------------
# Inline content markup
# --------------------------------------------------------------------------

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
CODE_RE = re.compile(r"`([^`]+)`")


def inline(text, lang, page):
    """Escape, then expand the small markup subset used in i18n content.

    Escaping happens first, so translated copy can never inject markup.
    Link targets of the form ~home / ~guide / ~faq / ~privacy resolve to the
    equivalent page in the current locale; anything else is used verbatim.
    """
    out = html.escape(str(text), quote=True)

    def link(match):
        label, href = match.group(1), match.group(2)
        if href.startswith("~"):
            target = href[1:]
            if target not in PAGES:
                raise ValueError(f"unknown link target: {href}")
            return f'<a href="{rel_href(lang, page, lang, target)}">{label}</a>'
        return f'<a href="{href}" target="_blank" rel="noopener">{label}</a>'

    out = LINK_RE.sub(link, out)
    out = BOLD_RE.sub(r"<strong>\1</strong>", out)
    out = CODE_RE.sub(r"<code>\1</code>", out)
    return out


def render_body(items, lang, page, indent="      "):
    """Render a body array: strings are paragraphs, objects are ul/ol lists."""
    out = []
    for item in items:
        if isinstance(item, str):
            out.append(f"{indent}<p>{inline(item, lang, page)}</p>")
            continue
        for tag in ("ul", "ol"):
            if tag in item:
                lis = "\n".join(
                    f"{indent}  <li>{inline(li, lang, page)}</li>" for li in item[tag]
                )
                out.append(f"{indent}<{tag}>\n{lis}\n{indent}</{tag}>")
                break
        else:
            raise ValueError(f"unsupported body item: {item!r}")
    return "\n".join(out)


def slugify(text):
    """Stable ASCII id for a section heading, used as its anchor.

    Empty when the heading is in a script that does not fold to ASCII: the
    odd Latin word left over ("scanpdf") would make a misleading anchor.
    """
    folded = unicodedata.normalize("NFKD", str(text).lower())
    folded = folded.replace("ß", "ss").replace("ł", "l").replace("ı", "i")
    if any(ch.isalpha() and not ch.isascii() for ch in folded):
        return ""
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")


def unique_anchor(text, used):
    """Anchor for a heading that is unique within its page.

    Headings in a non-Latin script fold to nothing (or to a stray "pdf"), so
    fall back to the section's position and de-duplicate what is left.
    """
    base = slugify(text) or f"section-{len(used) + 1}"
    anchor, n = base, 1
    while anchor in used:
        n += 1
        anchor = f"{base}-{n}"
    used.add(anchor)
    return anchor


# --------------------------------------------------------------------------
# URLs
# --------------------------------------------------------------------------


def url_path(lang, page):
    prefix = "/" if lang == DEFAULT_LANG else f"/{lang}/"
    if page == "home":
        return prefix
    return f"{prefix}{LOCALES[lang]['slugs'][page]}/"


def canonical(lang, page):
    return ORIGIN + url_path(lang, page)


def out_file(lang, page):
    relative = url_path(lang, page).strip("/")
    return SITE / relative / "index.html" if relative else SITE / "index.html"


def base_prefix(lang, page):
    """Path back to the site root from a page, e.g. "../../" under /es/faq/.

    Every in-page reference is relative, so the bundle keeps working when it
    is served from a sub-path -- which is what the release zip is for. Only
    the SEO metadata (canonical, hreflang, og:image) is absolute, as it has
    to be.
    """
    return "../" * len([s for s in url_path(lang, page).split("/") if s])


def rel_href(from_lang, from_page, to_lang, to_page):
    href = base_prefix(from_lang, from_page) + url_path(to_lang, to_page).lstrip("/")
    return href or "./"


def linker(lang, page, absolute):
    """Return the href builder for a page.

    404.html is the exception that needs absolute paths: GitHub Pages serves
    it for any missing URL at any depth, while the address bar keeps the
    requested path, so relative references would resolve against that.
    """
    if absolute:
        return lambda to_lang, to_page: url_path(to_lang, to_page)
    return lambda to_lang, to_page: rel_href(lang, page, to_lang, to_page)


# --------------------------------------------------------------------------
# Head, navigation, structured data
# --------------------------------------------------------------------------


def hreflang_block(page):
    lines = [
        f'<link rel="alternate" hreflang="{lang}" href="{canonical(lang, page)}">'
        for lang in LANGS
    ]
    lines.append(
        f'<link rel="alternate" hreflang="x-default" href="{canonical(DEFAULT_LANG, page)}">'
    )
    return "\n".join(lines)


def og_locale_alternates(lang):
    return "\n".join(
        f'<meta property="og:locale:alternate" content="{LOCALES[other]["ogLocale"]}">'
        for other in LANGS
        if other != lang
    )


def nav_links(lang, current, href_for):
    links = []
    for page in PAGES:
        label = LOCALES[lang]["nav"][page]
        href = href_for(lang, page)
        aria = ' aria-current="page"' if page == current else ""
        links.append(f'<a href="{href}"{aria}>{html.escape(label)}</a>')
    return "".join(links)


def menu_order(lang):
    """Sort key for the language menu: alphabetical by the native name.

    The order is the same on every page, so a visitor who cannot read the
    current locale still finds their own language in a familiar place. Accents
    are folded for collation, and names in a non-Latin script follow the
    Latin ones rather than being interleaved by code point.
    """
    name = LOCALES[lang]["name"]
    folded = unicodedata.normalize("NFKD", name).casefold()
    key = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return (not key[:1].isascii(), key)


def lang_links(lang, page, href_for):
    links = []
    for other in sorted(LANGS, key=menu_order):
        label = LOCALES[other]["name"]
        href = href_for(other, page)
        current = ' aria-current="true" class="current"' if other == lang else ""
        links.append(
            f'<a href="{href}" hreflang="{other}" lang="{other}"{current}>'
            f"{html.escape(label)}</a>"
        )
    return "".join(links)


def breadcrumb_html(lang, page):
    home = LOCALES[lang]["nav"]["home"]
    here = LOCALES[lang]["nav"][page]
    return (
        f'<a href="{rel_href(lang, page, lang, "home")}">{html.escape(home)}</a>'
        f'<span aria-hidden="true">/</span>'
        f"<span>{html.escape(here)}</span>"
    )


def ld_json(data):
    """Serialize a JSON-LD graph. ld+json is a data block, not executable, so
    it is not affected by the script-src CSP."""
    body = json.dumps(data, ensure_ascii=False, indent=2).replace("</", "<\\/")
    return f'<script type="application/ld+json">\n{body}\n</script>'


def software_application_ld(lang):
    loc = LOCALES[lang]
    return ld_json(
        {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "WebSite",
                    "@id": f"{ORIGIN}/#website",
                    "url": ORIGIN + "/",
                    "name": "ScanPDF",
                    "description": loc["app"]["description"],
                    "inLanguage": lang,
                },
                {
                    "@type": "SoftwareApplication",
                    "@id": f"{ORIGIN}/#app",
                    "name": "ScanPDF",
                    "url": canonical(lang, "home"),
                    "description": loc["app"]["description"],
                    "applicationCategory": "UtilitiesApplication",
                    "operatingSystem": "Any (web browser)",
                    "browserRequirements": "Requires JavaScript and WebAssembly",
                    "inLanguage": lang,
                    "image": f"{ORIGIN}/og/social-preview.png",
                    "license": "https://opensource.org/licenses/MIT",
                    "isAccessibleForFree": True,
                    "offers": {
                        "@type": "Offer",
                        "price": "0",
                        "priceCurrency": "USD",
                    },
                    "featureList": loc["featureList"],
                },
            ],
        }
    )


def breadcrumb_ld(lang, page):
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "name": LOCALES[lang]["nav"]["home"],
                "item": canonical(lang, "home"),
            },
            {
                "@type": "ListItem",
                "position": 2,
                "name": LOCALES[lang]["nav"][page],
                "item": canonical(lang, page),
            },
        ],
    }


def content_ld(lang, page):
    loc = LOCALES[lang]
    data = loc["pages"][page]
    if page == "faq":
        main = {
            "@type": "FAQPage",
            "name": data["h1"],
            "description": data["description"],
            "inLanguage": lang,
            "url": canonical(lang, page),
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": item["q"],
                    "acceptedAnswer": {
                        "@type": "Answer",
                        "text": " ".join(strip_markup(p) for p in item["a"]),
                    },
                }
                for item in data["faq"]
            ],
        }
    else:
        main = {
            "@type": "Article",
            "headline": data["h1"],
            "description": data["description"],
            "inLanguage": lang,
            "url": canonical(lang, page),
            "image": f"{ORIGIN}/og/social-preview.png",
            "author": {"@type": "Organization", "name": "ScanPDF", "url": ORIGIN + "/"},
            "publisher": {
                "@type": "Organization",
                "name": "ScanPDF",
                "url": ORIGIN + "/",
            },
            "isPartOf": {"@id": f"{ORIGIN}/#website"},
        }
    return ld_json(
        {"@context": "https://schema.org", "@graph": [main, breadcrumb_ld(lang, page)]}
    )


def strip_markup(text):
    """Plain-text version of a content string, for JSON-LD answer bodies."""
    out = LINK_RE.sub(r"\1", str(text))
    out = BOLD_RE.sub(r"\1", out)
    out = CODE_RE.sub(r"\1", out)
    return out


# --------------------------------------------------------------------------
# Page assembly
# --------------------------------------------------------------------------


def base_ctx(lang, page, title, description, og_title, og_description, og_alt, og_type,
             absolute=False):
    loc = LOCALES[lang]
    href_for = linker(lang, page, absolute)
    prefix = "/" if absolute else base_prefix(lang, page)
    manifest = prefix + ("manifest.webmanifest" if lang == DEFAULT_LANG
                         else f"{lang}/manifest.webmanifest")
    head_ctx = {
        "base": prefix,
        "title": title,
        "description": description,
        "canonical": canonical(lang, page),
        "hreflang": hreflang_block(page),
        "ogType": og_type,
        "ogTitle": og_title,
        "ogDescription": og_description,
        "ogImageAlt": og_alt,
        "ogLocale": loc["ogLocale"],
        "ogLocaleAlternates": og_locale_alternates(lang),
        "origin": ORIGIN,
        "manifestHref": manifest,
    }
    footer_ctx = {
        "navLinks": nav_links(lang, page, href_for),
        "navSectionsLabel": loc["nav"]["sectionsLabel"],
        "navProjectLabel": loc["nav"]["projectLabel"],
        "footerSource": loc["footer"]["source"],
        "footerLicense": loc["footer"]["license"],
        "footerIssues": loc["footer"]["issues"],
    }
    lang_menu_ctx = {
        "langLinks": lang_links(lang, page, href_for),
        "navLanguageLabel": loc["nav"]["languageLabel"],
    }
    theme_ctx = {
        "navThemeSystem": loc["nav"]["themeSystem"],
        "navThemeLight": loc["nav"]["themeLight"],
        "navThemeDark": loc["nav"]["themeDark"],
    }
    ctx = dict(footer_ctx)
    ctx.update(
        {
            "lang": lang,
            "head": render(read(TEMPLATES / "_head.html"), head_ctx).strip(),
            "footer": render(read(TEMPLATES / "_footer.html"), footer_ctx).strip(),
            "langMenu": render(read(TEMPLATES / "_langmenu.html"), lang_menu_ctx).strip(),
            "themeToggle": render(read(TEMPLATES / "_thememenu.html"), theme_ctx).strip(),
            "brandMark": read(TEMPLATES / "_brandmark.html").strip(),
            "base": prefix,
            "homeHref": href_for(lang, "home"),
            "navSkipToContent": loc["nav"]["skipToContent"],
            "navOpenScanner": loc["nav"]["openScanner"],
            "ctaText": loc["nav"]["ctaText"],
        }
    )
    return ctx


def ui_data_attributes(lang):
    """The JS-side strings, as data-* attributes on the #i18n carrier."""
    out = []
    for key, value in LOCALES[lang]["ui"].items():
        attr = re.sub(r"(?<!^)([A-Z])", r"-\1", key).lower()
        out.append(f' data-{attr}="{html.escape(str(value), quote=True)}"')
    return "".join(out)


def build_app_page(lang):
    loc = LOCALES[lang]
    app = loc["app"]
    ctx = base_ctx(
        lang,
        "home",
        app["title"],
        app["description"],
        app["ogTitle"],
        app["ogDescription"],
        app["ogImageAlt"],
        "website",
    )
    ctx["jsonld"] = software_application_ld(lang)
    ctx["uiStrings"] = ui_data_attributes(lang)
    for key, value in app.items():
        ctx["app" + key[0].upper() + key[1:]] = value
    return render(read(TEMPLATES / "app.html"), ctx)


def build_content_page(lang, page):
    loc = LOCALES[lang]
    data = loc["pages"][page]
    ctx = base_ctx(
        lang,
        page,
        data["title"],
        data["description"],
        data["h1"],
        data["description"],
        data["ogImageAlt"],
        "article",
    )
    ctx["jsonld"] = content_ld(lang, page)
    ctx["h1"] = data["h1"]
    ctx["lead"] = inline(data["lead"], lang, page)
    ctx["breadcrumb"] = breadcrumb_html(lang, page)

    blocks = []
    used = set()
    if page == "faq":
        for item in data["faq"]:
            anchor = unique_anchor(strip_markup(item["q"]), used)
            blocks.append(
                f'    <section class="faq-item" id="{anchor}">\n'
                f'      <h2>{inline(item["q"], lang, page)}</h2>\n'
                f'{render_body(item["a"], lang, page)}\n'
                f"    </section>"
            )
    else:
        for section in data["sections"]:
            anchor = unique_anchor(strip_markup(section["h"]), used)
            blocks.append(
                f'    <section id="{anchor}">\n'
                f'      <h2>{inline(section["h"], lang, page)}</h2>\n'
                f'{render_body(section["body"], lang, page)}\n'
                f"    </section>"
            )
    ctx["sections"] = "\n".join(blocks)
    return render(read(TEMPLATES / "content.html"), ctx)


def build_not_found():
    loc = LOCALES[DEFAULT_LANG]
    nf = loc["notFound"]
    ctx = base_ctx(
        DEFAULT_LANG,
        "home",
        nf["title"],
        nf["body"],
        nf["heading"],
        nf["body"],
        loc["app"]["ogImageAlt"],
        "website",
        absolute=True,
    )
    ctx["jsonld"] = ""
    ctx["heading"] = nf["heading"]
    ctx["body"] = nf["body"]
    ctx["cta"] = nf["cta"]
    return render(read(TEMPLATES / "404.html"), ctx)


def build_manifest(lang):
    loc = LOCALES[lang]
    # A manifest's relative URLs resolve against the manifest itself, which
    # sits next to the locale's index.html, so these stay sub-path safe.
    prefix = "./" if lang == DEFAULT_LANG else "../"
    return json.dumps(
        {
            "name": loc["manifest"]["name"],
            "short_name": loc["manifest"]["shortName"],
            "description": loc["manifest"]["description"],
            "lang": lang,
            "dir": "ltr",
            "start_url": "./",
            "scope": prefix,
            "display": "standalone",
            "orientation": "any",
            "background_color": "#12151b",
            "theme_color": "#12151b",
            "categories": ["productivity", "utilities"],
            "icons": [
                {"src": prefix + "favicon.svg", "sizes": "any", "type": "image/svg+xml"},
                {"src": prefix + "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": prefix + "icons/icon-256.png", "sizes": "256x256", "type": "image/png"},
                {
                    "src": prefix + "icons/icon-512.png",
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "any maskable",
                },
            ],
            # "Share -> ScanPDF" from an Android gallery. Nothing is uploaded:
            # the service worker answers this POST on the device (sw.js).
            "share_target": {
                "action": "./share-target",
                "method": "POST",
                "enctype": "multipart/form-data",
                "params": {"files": [{"name": "images", "accept": ["image/*"]}]},
            },
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def build_sitemap():
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for page in PAGES:
        alternates = [
            f'    <xhtml:link rel="alternate" hreflang="{lang}" href="{canonical(lang, page)}"/>'
            for lang in LANGS
        ]
        alternates.append(
            f'    <xhtml:link rel="alternate" hreflang="x-default"'
            f' href="{canonical(DEFAULT_LANG, page)}"/>'
        )
        for lang in LANGS:
            lines.append("  <url>")
            lines.append(f"    <loc>{canonical(lang, page)}</loc>")
            lines.extend(alternates)
            lines.append(
                "    <priority>1.0</priority>" if page == "home" else "    <priority>0.8</priority>"
            )
            lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def build_robots():
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        f"Sitemap: {ORIGIN}/sitemap.xml\n"
    )


# --------------------------------------------------------------------------
# Service worker
# --------------------------------------------------------------------------


def precache_urls():
    """Scope-relative URLs of the offline app shell, in a stable order.

    Pages are listed as directories ("es/faq/"), the way they are linked.
    vendor/ is left out on purpose: see ENGINE in templates/sw.js.
    """
    urls = {"404.html", "favicon.svg"}
    for lang in LANGS:
        for page in PAGES:
            urls.add(url_path(lang, page).lstrip("/") or "./")
        urls.add("manifest.webmanifest" if lang == DEFAULT_LANG
                 else f"{lang}/manifest.webmanifest")
    for folder, pattern in (("css", "*.css"), ("js", "*.js"), ("icons", "*.png")):
        urls.update(f"{folder}/{path.name}" for path in (SITE / folder).glob(pattern))
    return sorted(urls)


def precache_file(url):
    if url == "./":
        return SITE / "index.html"
    return SITE / url / "index.html" if url.endswith("/") else SITE / url


def build_service_worker():
    """Fill templates/sw.js with the precache list and the cache versions.

    Nothing in site/ is fingerprinted, so VERSION -- a hash of every precached
    file plus the worker itself -- is what makes browsers pick up a release.
    It has to run after everything else has been written.
    """
    template = read(TEMPLATES / "sw.js")
    urls = precache_urls()
    digest = hashlib.sha256(template.encode("utf-8"))
    for url in urls:
        path = precache_file(url)
        data = path.read_bytes()
        if path.suffix != ".png":
            data = data.replace(b"\r\n", b"\n")  # same hash on a CRLF checkout
        digest.update(url.encode("utf-8") + b"\0" + data + b"\0")
    engine = hashlib.sha256(read(ROOT / "vendor-checksums.txt").encode("utf-8"))
    out = template
    for token, value in (
        ("__VERSION__", digest.hexdigest()[:12]),
        ("__ENGINE_VERSION__", engine.hexdigest()[:12]),
        ("/*__PRECACHE__*/", ",\n  ".join(json.dumps(url) for url in urls)),
    ):
        # Plain replace, not render(): JS may contain braces, and render()
        # HTML-escapes.
        if out.count(token) != 1:
            sys.exit(f"templates/sw.js: expected exactly one {token}")
        out = out.replace(token, value)
    return out


# --------------------------------------------------------------------------


def read(path):
    return path.read_text(encoding="utf-8")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not text.endswith("\n"):
        text += "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"  {path.relative_to(ROOT)}")


LOCALES = {}

PLACEHOLDER_RE = re.compile(r"\{\w+\}")


def check_parity(ref, other, path, errors):
    """Collect every place a locale's shape differs from the default one.

    Templates fail loudly on a missing key, but the run-time "ui" strings,
    "featureList" and "slugs" are read by iteration and would go out silently.
    """
    if isinstance(ref, dict) and isinstance(other, dict):
        for key in ref.keys() - other.keys():
            errors.append(f"{path}.{key}: missing")
        for key in other.keys() - ref.keys():
            errors.append(f"{path}.{key}: unexpected")
        for key in ref.keys() & other.keys():
            check_parity(ref[key], other[key], f"{path}.{key}", errors)
    elif isinstance(ref, list) and isinstance(other, list):
        if len(ref) != len(other):
            errors.append(f"{path}: {len(other)} items, expected {len(ref)}")
        for i, (a, b) in enumerate(zip(ref, other)):
            check_parity(a, b, f"{path}[{i}]", errors)
    elif type(ref) is not type(other):
        errors.append(f"{path}: expected {type(ref).__name__}")
    elif isinstance(ref, str):
        if not other.strip():
            errors.append(f"{path}: empty")
        if set(PLACEHOLDER_RE.findall(ref)) != set(PLACEHOLDER_RE.findall(other)):
            errors.append(f"{path}: placeholders differ from {DEFAULT_LANG}")


def main():
    for lang in LANGS:
        source = I18N / f"{lang}.json"
        if not source.exists():
            sys.exit(f"missing locale file: {source.relative_to(ROOT)}")
        LOCALES[lang] = json.loads(read(source))

    errors = []
    for lang in LANGS:
        if LOCALES[lang].get("lang") != lang:
            errors.append(f"{lang}.lang: expected {lang!r}")
        check_parity(LOCALES[DEFAULT_LANG], LOCALES[lang], lang, errors)
    if errors:
        sys.exit("locale files out of sync:\n  " + "\n  ".join(sorted(errors)))

    print("Rendering site/ from templates/ + i18n/")
    for lang in LANGS:
        write(out_file(lang, "home"), build_app_page(lang))
        for page in CONTENT_PAGES:
            write(out_file(lang, page), build_content_page(lang, page))
        target = "manifest.webmanifest" if lang == DEFAULT_LANG else f"{lang}/manifest.webmanifest"
        write(SITE / target, build_manifest(lang))

    write(SITE / "404.html", build_not_found())
    write(SITE / "sitemap.xml", build_sitemap())
    write(SITE / "robots.txt", build_robots())
    write(SITE / "sw.js", build_service_worker())  # last: it hashes the rest
    print("Done.")


if __name__ == "__main__":
    main()
