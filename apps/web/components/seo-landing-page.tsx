import Link from "next/link";
import type { SeoLandingPage } from "@/lib/seo-landing-pages";
import { PRODUCT_SEO_PAGES } from "@/lib/seo-landing-pages";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";

const RELATED_LABELS: Record<string, string> = {
  "telegram-video-clipper-bots": "Telegram video clipper bots: workflow and comparison",
  "ai-clipping-tools-compared": "Compare AI clipping tools and billing units",
  "opus-clip-alternative": "Opus Clip alternative comparison",
  "submagic-alternative": "Submagic alternative comparison",
  "eklipse-alternative": "Eklipse alternative comparison",
  "klap-alternative": "Klap alternative comparison",
  "crayo-alternative": "Crayo alternative comparison",
};

function relatedLabel(slug: string): string {
  return (
    PRODUCT_SEO_PAGES.find((page) => page.slug === slug)?.breadcrumb ??
    RELATED_LABELS[slug] ??
    slug
  );
}

function relatedHref(slug: string): string {
  return slug === "/" ? "/" : `/${slug}`;
}

function isExternal(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://");
}

function ActionLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const className =
    "inline-flex items-center rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-white";

  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function RelatedProductPages({
  current,
  slugs,
}: {
  current?: string;
  slugs?: readonly string[];
}) {
  const currentPage = current
    ? PRODUCT_SEO_PAGES.find((page) => page.slug === current)
    : undefined;
  const related = (slugs ?? currentPage?.relatedSlugs ?? []).filter(
    (slug) => slug !== current && slug !== currentPage?.slug,
  );

  if (related.length === 0) return null;

  return (
    <nav aria-label="Related ClipClap pages" className="mt-12 border-t border-white/[0.08] pt-6">
      <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Continue exploring</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {related.map((slug) => (
          <li key={slug}>
            <Link
              href={relatedHref(slug)}
              className="text-sm text-neutral-300 underline-offset-4 hover:text-white hover:underline"
            >
              {relatedLabel(slug)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Breadcrumbs({ page, url }: { page: SeoLandingPage; url: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-neutral-500">
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link href="/" className="hover:text-white hover:underline">
            Home
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-neutral-300">
          {page.breadcrumb}
        </li>
      </ol>
      <span className="sr-only">Current page: {url}</span>
    </nav>
  );
}

export function SeoLandingPage({ page }: { page: SeoLandingPage }) {
  const url = new URL(page.path, SITE).toString();
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: page.title,
        description: page.description,
        isPartOf: { "@id": `${SITE}/#website` },
        inLanguage: "en",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: page.breadcrumb, item: url },
        ],
      },
    ],
  };

  return (
    <main className="min-h-screen bg-black text-neutral-200">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
      <header className="border-b border-white/[0.06] px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <Link href="/" className="text-sm font-medium text-white">
            ClipClap
          </Link>
          <ActionLink href={page.ctaHref}>{page.ctaLabel}</ActionLink>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-10 sm:py-16">
        <Breadcrumbs page={page} url={url} />

        <section className="mt-10 max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-500">
            {page.eyebrow}
          </p>
          <h1 className="mt-4 text-3xl font-bold tracking-[-0.04em] text-white sm:text-5xl">
            {page.h1}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-neutral-300 sm:text-lg">
            {page.intro}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <ActionLink href={page.ctaHref}>{page.ctaLabel}</ActionLink>
            <Link
              href="/"
              className="rounded-lg px-2 py-2.5 text-sm text-neutral-400 underline-offset-4 hover:text-white hover:underline"
            >
              See how ClipClap works
            </Link>
          </div>
        </section>

        <section aria-label="At a glance" className="mt-12 grid gap-3 sm:grid-cols-3">
          {page.proofPoints.map((point) => (
            <div key={point.label} className="border-t border-white/15 pt-4">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-neutral-500">
                {point.label}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-neutral-200">{point.value}</p>
            </div>
          ))}
        </section>

        <section aria-labelledby="workflow-heading" className="mt-16 border-t border-white/10 pt-10">
          <h2 id="workflow-heading" className="text-2xl font-semibold tracking-tight text-white">
            {page.summary}
          </h2>
          <ol className="mt-7 grid gap-8 md:grid-cols-3">
            {page.workflow.map((step, index) => (
              <li key={step.title} className="border-t border-white/15 pt-5">
                <span className="font-mono text-xs text-neutral-500">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 font-medium text-white">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="limits-heading" className="mt-16 border-t border-white/10 pt-10">
          <h2 id="limits-heading" className="text-2xl font-semibold tracking-tight text-white">
            What to check before publishing
          </h2>
          <ul className="mt-6 grid gap-4 text-sm leading-relaxed text-neutral-400 md:grid-cols-2">
            {page.limitations.map((limitation) => (
              <li key={limitation} className="border-l border-white/20 pl-4">
                {limitation}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="questions-heading" className="mt-16 border-t border-white/10 pt-10">
          <h2 id="questions-heading" className="text-2xl font-semibold tracking-tight text-white">
            Questions about {page.breadcrumb.toLowerCase()}
          </h2>
          <dl className="mt-6 space-y-6 text-sm leading-relaxed">
            {page.questions.map((item) => (
              <div key={item.question}>
                <dt className="font-medium text-white">{item.question}</dt>
                <dd className="mt-2 text-neutral-400">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <RelatedProductPages current={page.slug} />

        <section className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-white">Try your first {page.breadcrumb.toLowerCase()}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
            Start with footage you can use, review the result yourself, and keep only the clips that deserve to be published.
          </p>
          <div className="mt-5">
            <ActionLink href={page.ctaHref}>{page.ctaLabel}</ActionLink>
          </div>
        </section>
      </div>
    </main>
  );
}
