"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "../../../i18n/navigation";
import { navItems, flatNavItems } from "./docs-nav-items";

export function DocsPager() {
  const pathname = usePathname();
  const t = useTranslations("docs.navItems");
  const flat = flatNavItems(navItems);
  const index = flat.findIndex((item) => item.href === pathname);
  const prev = index > 0 ? flat[index - 1] : null;
  const next = index < flat.length - 1 ? flat[index + 1] : null;
  const titleFor = (item: (typeof flat)[number]) => {
    try {
      return t(item.titleKey);
    } catch {
      return item.fallbackTitle ?? item.titleKey;
    }
  };

  if (!prev && !next) return null;

  return (
    <nav className="flex items-center justify-between mt-12 pt-6 border-t border-border text-[14px]">
      {prev ? (
        <Link
          href={prev.href}
          className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors"
        >
          <span aria-hidden>&larr;</span>
          {titleFor(prev)}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors"
        >
          {titleFor(next)}
          <span aria-hidden>&rarr;</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
