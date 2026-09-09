#!/usr/bin/env python3
"""Check rendered public SEO contracts. Usage: python3 scripts/check-seo.py [base URL]."""
import json
import sys
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://clipclap.io').rstrip('/')
SITE = 'https://clipclap.io'
TARGETS = ['/telegram-video-clipper-bots', '/opus-clip-alternative']


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.canonical, self.robots, self.links = [], [], []
        self.headings, self.schemas = [], []
        self.h1 = self.jsonld = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'link' and attrs.get('rel') == 'canonical':
            self.canonical.append(attrs.get('href'))
        if tag == 'meta' and attrs.get('name') in ('robots', 'googlebot'):
            self.robots.append(attrs.get('content', ''))
        if tag == 'a':
            self.links.append(attrs.get('href', ''))
        if tag == 'h1':
            self.h1 = True
            self.headings.append('')
        if tag == 'script' and attrs.get('type') == 'application/ld+json':
            self.jsonld = True
            self.schemas.append('')

    def handle_endtag(self, tag):
        if tag == 'h1':
            self.h1 = False
        if tag == 'script':
            self.jsonld = False

    def handle_data(self, data):
        if self.h1:
            self.headings[-1] += data
        if self.jsonld:
            self.schemas[-1] += data


def fetch(path):
    with urlopen(Request(BASE + path, headers={'User-Agent': 'ClipClap-SEO-Check/1.0'}), timeout=30) as r:
        assert r.status == 200, (path, r.status)
        assert r.url == BASE + path, ('unexpected redirect', path, r.url)
        return r.read().decode(), r.headers


robots_text, _ = fetch('/robots.txt')
robots = RobotFileParser()
robots.parse(robots_text.splitlines())
xml, _ = fetch('/sitemap.xml')
root = ElementTree.fromstring(xml)
ns = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}
urls = [e.text for e in root.findall('s:url/s:loc', ns)]
assert len(urls) == len(set(urls)), 'Duplicate sitemap entries'
assert len(urls) == 8, f'Expected 8 public pages, found {len(urls)}'
assert all(u == SITE or u.startswith(SITE + '/') for u in urls), 'Noncanonical sitemap URL'
paths = [u[len(SITE):] or '/' for u in urls]
assert all(p in paths for p in TARGETS), 'Priority pages absent from sitemap'
assert '/login' not in paths
pages = {}
for path in paths:
    html, headers = fetch(path)
    page = pages[path] = Page(html)
    assert page.canonical == [SITE + (path if path != '/' else '')] or (path == '/' and page.canonical == [SITE + '/']), (path, page.canonical)
    assert not any('noindex' in r.lower() or 'none' in r.lower() for r in page.robots), (path, 'meta noindex')
    assert 'noindex' not in headers.get('X-Robots-Tag', '').lower(), (path, 'header noindex')
    assert robots.can_fetch('Googlebot', SITE + path), (path, 'robots blocked')
    assert len(page.headings) == 1 and page.headings[0].strip(), (path, 'one SSR H1 required')
    for schema in page.schemas:
        json.loads(schema)
    print('PASS', path, '200 / canonical / indexable / SSR H1 / valid JSON-LD')

assert 'ai video clipper' in pages['/'].headings[0].lower(), 'Homepage H1 lacks core intent'
for source in ['/', '/ai-clipping-tools-compared', '/klap-alternative', '/submagic-alternative']:
    assert all(p in pages[source].links for p in TARGETS), (source, 'missing priority links')
login, _ = fetch('/login')
assert any('noindex' in r for r in Page(login).robots), 'Login must remain noindex'
print('PASS priority internal links and login noindex; this does not confirm Google indexing.')
