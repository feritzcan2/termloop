"use client";

import { useTranslations } from "next-intl";
import { Link } from "../../../i18n/navigation";

export function NavLinks() {
  const t = useTranslations("nav");
  return (
    <>
      <Link
        href="/docs/getting-started"
        className="hover:text-foreground transition-colors"
      >
        {t("docs")}
      </Link>
      <Link
        href="/blog"
        className="hover:text-foreground transition-colors"
      >
        {t("blog")}
      </Link>
      <Link
        href="/docs/changelog"
        className="hover:text-foreground transition-colors"
      >
        {t("changelog")}
      </Link>
      <Link
        href="/community"
        className="hover:text-foreground transition-colors"
      >
        {t("community")}
      </Link>
      <a
        href="https://github.com/feritzcan2/termloop"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground transition-colors"
      >
        {t("github")}
      </a>
    </>
  );
}
