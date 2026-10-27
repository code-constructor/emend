import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useLayout } from "../../lib/layout.ts";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Sheet.tsx";

export function AppFrame({
  title,
  isReview = false,
  children,
  inbox,
  revisionMenu,
  desktopAction,
}: {
  title: string;
  isReview?: boolean;
  children: ReactNode;
  inbox?: ReactNode;
  revisionMenu?: ReactNode;
  desktopAction?: ReactNode;
}) {
  const layout = useLayout();
  const [copyMessage, setCopyMessage] = useState("");
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname + location.search);
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Could not copy the link. Copy it from the address bar.");
    }
  }
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 dark:border-neutral-800">
        {layout === "phone" ? (
          <>
            {isReview && (
              <Button asChild>
                <Link to="/">Inbox</Link>
              </Button>
            )}
            <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
            <Sheet title="More" trigger={<Button aria-label="More">⋯</Button>}>
              {isReview ? (
                <>
                  {revisionMenu}
                  <Button className="w-full" onClick={() => void copyLink()}>
                    Copy link
                  </Button>
                  {copyMessage && <p role="status">{copyMessage}</p>}
                  <Link className="block py-2" to="/">
                    Inbox
                  </Link>
                  <Link className="block py-2" to="/devices">
                    Devices
                  </Link>
                </>
              ) : (
                <>
                  <Link className="block py-2" to="/devices">
                    Devices
                  </Link>
                  <Link className="block py-2" to="/devices">
                    Pair a device
                  </Link>
                </>
              )}
            </Sheet>
          </>
        ) : (
          <>
            <Link to="/" className="text-lg font-semibold tracking-tight">
              emend
            </Link>
            <span className="text-neutral-400" aria-hidden="true">
              /
            </span>
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-sm">
              {isReview ? (
                <>
                  <Link to="/" className="text-neutral-500">
                    Inbox
                  </Link>
                  <span aria-hidden="true"> / </span>
                </>
              ) : null}
              {title}
            </nav>
            {layout === "tablet" && inbox && (
              <Sheet title="Inbox" trigger={<Button>Inbox</Button>}>
                {inbox}
              </Sheet>
            )}
            {layout === "desktop" && desktopAction}
            <Link to="/devices" className="px-2 py-2 text-sm text-blue-700 dark:text-blue-400">
              Devices
            </Link>
          </>
        )}
      </header>
      {children}
    </div>
  );
}
