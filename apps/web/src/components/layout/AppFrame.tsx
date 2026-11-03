import { Link, useRouter } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, Inbox, Link as LinkIcon, MessageSquarePlus, QrCode, Smartphone } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useLayout } from "../../lib/layout.ts";
import { useLayoutPreferences } from "../../lib/layout-store.ts";
import { requestPairingFromLink } from "../../lib/pairing-intent.ts";
import { textSizeItems } from "../review/LayoutControls.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { useToast } from "../ui/Toast.tsx";
import { cn } from "../ui/utils.ts";

export function AppFrame({
  isReview = false,
  children,
  onCommentReview,
}: {
  isReview?: boolean;
  children: ReactNode;
  onCommentReview?: () => void;
}) {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  const router = useRouter();
  const toast = useToast();
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname + location.search);
      toast.show({ title: "Link copied" });
    } catch {
      toast.show({ title: "Could not copy the link. Copy it from the address bar.", tone: "danger" });
    }
  }
  const devices: MenuItem = {
    label: "Devices",
    icon: Smartphone,
    asChild: true,
    children: <Link to="/devices">Devices</Link>,
  };
  const menuItems: MenuItem[] = isReview
    ? [
        { label: "Copy link", icon: LinkIcon, onSelect: () => void copyLink() },
        ...(onCommentReview
          ? [{ label: "Comment on review", icon: MessageSquarePlus, onSelect: onCommentReview }]
          : []),
        { separator: true },
        ...textSizeItems(preferences),
        { separator: true },
        { label: "Inbox", icon: Inbox, asChild: true, children: <Link to="/">Inbox</Link> },
        devices,
      ]
    : [
        devices,
        {
          label: "Pair a device",
          icon: QrCode,
          asChild: true,
          children: (
            <Link to="/devices/pair" onClick={(event) => requestPairingFromLink(event, router.history.location)}>
              Pair a device
            </Link>
          ),
        },
      ];
  return (
    <div
      className="em-app flex h-dvh min-h-0 flex-col bg-app"
      style={
        {
          "--reader-prose-size": `${preferences.proseSize}px`,
          "--reader-code-size": `${preferences.codeSize}px`,
        } as CSSProperties
      }
    >
      <header
        className={cn(
          "flex shrink-0 items-center justify-between border-b border-line-1 bg-app pr-2 pl-4",
          layout === "phone"
            ? "h-[calc(var(--topbar-h)+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]"
            : "h-(--topbar-h)",
        )}
      >
        {layout === "phone" && isReview ? (
          <Link
            to="/"
            className="inline-flex min-h-11 items-center gap-1 text-13 font-medium text-fg-2 no-underline hover:text-fg-1"
          >
            <Icon icon={ChevronLeft} size={20} />
            Inbox
          </Link>
        ) : (
          <Link
            to="/"
            className="font-mono text-14 font-medium leading-none font-stretch-mono text-fg-3 no-underline hover:text-fg-1"
          >
            emend
          </Link>
        )}
        {layout === "phone" ? (
          <Menu
            label="More"
            size="lg"
            trigger={<IconButton label="More" icon={Ellipsis} size="lg" tooltip={false} />}
            items={menuItems}
          />
        ) : (
          <IconButton label="Devices" icon={Smartphone} asChild>
            <Link to="/devices" />
          </IconButton>
        )}
      </header>
      {children}
    </div>
  );
}
