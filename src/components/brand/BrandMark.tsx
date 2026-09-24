/**
 * The Mongo Bongo mark: a pair of bongo drum heads, the larger one solid and
 * the smaller one at half strength. Always paints with currentColor - in-app
 * that is `var(--accent)`. `outline` is the watermark variant for empty panes.
 */
export function BrandMark({
  className,
  outline = false,
  style,
}: {
  className?: string;
  outline?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <svg viewBox="0 0 120 120" className={className} style={style} aria-hidden>
      <circle cx="42" cy="72" r="27" fill="currentColor" />
      {outline ? (
        <circle cx="87" cy="45" r="18" fill="none" stroke="currentColor" strokeWidth="2.5" />
      ) : (
        <circle cx="87" cy="45" r="19" fill="currentColor" opacity=".5" />
      )}
    </svg>
  );
}

/** Gradient app-icon tile - only for the OS icon / about screen. */
export function BrandTile({ size = 64 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        background: "linear-gradient(150deg,#12E96A,#00A24C 62%,#00684A)",
        boxShadow: "0 18px 40px -18px rgba(0,180,90,.55), inset 0 1px 0 rgba(255,255,255,.35)",
        display: "grid",
        placeItems: "center",
        color: "#04180D",
        flex: "none",
      }}
    >
      <BrandMark style={{ width: size * 0.55, height: size * 0.55 }} />
    </div>
  );
}
