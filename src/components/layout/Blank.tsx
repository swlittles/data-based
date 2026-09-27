import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "@/lib/api";
import { BrandMark } from "@/components/brand/BrandMark";
import { useConnections } from "@/stores/connections";
import { cn } from "@/lib/utils";

let cachedEnv: string | null = null;

/** "Mongo Bongo 0.1.0 · macOS · arm64" line, resolved once. */
export function useVersionLine() {
  const [line, setLine] = useState<{ version: string; env: string }>({ version: "", env: cachedEnv ?? "" });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const version = await getVersion().catch(() => "");
      if (!cachedEnv) cachedEnv = await api.appEnv().catch(() => navigator.platform);
      if (alive) setLine({ version, env: cachedEnv ?? "" });
    })();
    return () => {
      alive = false;
    };
  }, []);
  return line;
}

/**
 * Every empty pane is this one component: outline mark at watermark opacity,
 * optional message, optional start actions pinned to the top and the version
 * block pinned 20px from the bottom.
 */
export function Blank({
  small,
  title,
  text,
  starts,
  actions,
  serverLine,
  className,
}: {
  small?: boolean;
  title?: string;
  text?: React.ReactNode;
  /** Chips pinned to the top of the pane. */
  starts?: React.ReactNode;
  /** Buttons rendered under the message. */
  actions?: React.ReactNode;
  /** Second line of the version block; defaults to the active server. */
  serverLine?: string;
  className?: string;
}) {
  const { version, env } = useVersionLine();
  const active = useConnections((s) => s.active);
  const server =
    serverLine ??
    (active
      ? active.engine === "postgres"
        ? `${active.topology} ${active.serverVersion} · ${active.hostSummary.split(",")[0]}`
        : `MongoDB ${active.serverVersion} · ${active.topology} · ${active.hostSummary.split(",")[0]}`
      : "No server session");

  return (
    <div className={cn("blank no-select", small && "sm", className)}>
      {starts && <div className="starts">{starts}</div>}
      <div className="wmark">
        <BrandMark outline />
      </div>
      {(title || text) && (
        <div className="msg">
          {title && <h4>{title}</h4>}
          {text && <p>{text}</p>}
        </div>
      )}
      {actions && <div className="acts">{actions}</div>}
      <div className="ver">
        <b>Mongo Bongo {version}</b>
        {env && ` · ${env}`}
        <span>{server}</span>
      </div>
    </div>
  );
}
