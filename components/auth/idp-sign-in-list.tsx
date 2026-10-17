"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { PublicJmapServerEntry } from "@/lib/admin/jmap-servers";

/** The provider this browser signed in with last, given the primary style next time. */
export const LAST_IDP_KEY = "login_last_server_id";

export function readLastIdp(): string | null {
  try {
    return localStorage.getItem(LAST_IDP_KEY);
  } catch {
    return null;
  }
}

export function rememberLastIdp(id: string): void {
  try {
    localStorage.setItem(LAST_IDP_KEY, id);
  } catch { /* storage unavailable */ }
}

/** The entry's icon, or its label's initial in a circle when it has none or it fails to load. */
function ProviderIcon({ server }: { server: PublicJmapServerEntry }) {
  const [failed, setFailed] = useState(false);
  if (server.icon && !failed) {
    return <img src={server.icon} alt="" className="w-5 h-5 object-contain shrink-0" onError={() => setFailed(true)} />;
  }
  return (
    <span
      aria-hidden="true"
      className="w-5 h-5 shrink-0 rounded-full bg-muted text-muted-foreground text-[11px] font-semibold leading-5 text-center uppercase"
    >
      {Array.from(server.label.trim())[0] ?? "?"}
    </span>
  );
}

interface IdpSignInListProps {
  /** In display order. */
  servers: PublicJmapServerEntry[];
  /** The button drawn as the primary action, if any. */
  primaryId: string | null;
  /** The provider whose sign-in is starting, shown with a spinner. */
  pendingId: string | null;
  /** The provider whose sign-in could not start, named in a notice. */
  failedId: string | null;
  onSelect: (server: PublicJmapServerEntry) => void;
}

/**
 * OAuth-only with several servers: one button per identity provider, so
 * signing in is a single click on the one people recognise.
 */
export function IdpSignInList({ servers, primaryId, pendingId, failedId, onSelect }: IdpSignInListProps) {
  const t = useTranslations("login");
  const failed = servers.find((s) => s.id === failedId);
  return (
    <div className="space-y-3">
      <p id="idp-list-label" className="text-sm font-medium text-foreground text-center">
        {t("idp_list_label")}
      </p>
      <div role="group" aria-labelledby="idp-list-label" className="space-y-2.5">
        {servers.map((server) => {
          const primary = server.id === primaryId;
          const pending = server.id === pendingId;
          return (
            <Button
              key={server.id}
              type="button"
              variant={primary ? "default" : "outline"}
              data-testid="idp-button"
              data-primary={primary || undefined}
              aria-busy={pending || undefined}
              onClick={() => onSelect(server)}
              disabled={pendingId !== null}
              className={cn(
                "w-full h-11 justify-start gap-3 px-4 font-medium text-[15px] rounded-xl",
                primary
                  ? "shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                  : "border-border/60 hover:bg-muted/50",
              )}
            >
              {pending ? <Loader2 className="w-5 h-5 shrink-0 animate-spin" /> : <ProviderIcon server={server} />}
              <span className="truncate">{server.label}</span>
            </Button>
          );
        })}
      </div>
      {failed && (
        <p role="alert" className="text-sm text-warning text-center leading-relaxed">
          {t("idp_start_failed", { provider: failed.label })}
        </p>
      )}
    </div>
  );
}
