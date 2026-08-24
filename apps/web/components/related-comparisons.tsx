import Link from "next/link";

/**
 * The one list of comparison pages, and the reason it exists as a component rather than as
 * markup repeated on each page.
 *
 * With five pages each carrying a hand-written list of the other four, adding a sixth means
 * touching six files and the internal link graph silently rots the first time somebody
 * forgets one. A page that is not linked from its siblings is a page a crawler reaches only
 * from the sitemap, which is the weakest way in.
 *
 * Adding a comparison page: add one row here and nothing else. `current` is the slug of the
 * page doing the rendering, and it is filtered out so no page links to itself.
 */
export const COMPARISON_PAGES = [
  { slug: "opus-clip-alternative", name: "Opus Clip" },
  { slug: "submagic-alternative", name: "Submagic" },
  { slug: "eklipse-alternative", name: "Eklipse" },
  { slug: "klap-alternative", name: "Klap" },
  { slug: "crayo-alternative", name: "Crayo" },
] as const;

export function RelatedComparisons({ current }: { current: string }) {
  const others = COMPARISON_PAGES.filter((p) => p.slug !== current);
  if (others.length === 0) return null;

  return (
    <nav className="mt-10 border-t border-white/[0.06] pt-6 text-sm">
      <p className="text-neutral-500">Related comparisons</p>
      <ul className="mt-2 space-y-1">
        {others.map((p) => (
          <li key={p.slug}>
            <Link
              href={`/${p.slug}`}
              className="text-neutral-300 underline-offset-4 hover:text-white hover:underline"
            >
              ClipClap compared with {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
