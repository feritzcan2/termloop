import type { ReactNode } from "react";

/**
 * A page the left navigation opens in the stage: a head with its title, and
 * a body that keeps narrow-list content at a readable width.
 */
export function PageFrame(props: { title: string; meta?: string | undefined; className?: string; children: ReactNode }) {
  return (
    <section className={`pane page-pane ${props.className ?? ""}`} aria-label={props.title}>
      <div className="pane-head">
        <b>{props.title}</b>
        {props.meta && <span className="meta">{props.meta}</span>}
      </div>
      <div className="page-body">{props.children}</div>
    </section>
  );
}
