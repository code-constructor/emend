import * as Primitive from "@radix-ui/react-tooltip";
import { type ComponentProps, createContext, type ReactElement, type ReactNode, useContext } from "react";
import { Kbd } from "./Kbd.tsx";
import "./Tooltip.css";

const ProviderPresent = createContext(false);

export function TooltipProvider(props: ComponentProps<typeof Primitive.Provider>) {
  return (
    <ProviderPresent.Provider value={true}>
      <Primitive.Provider delayDuration={350} {...props} />
    </ProviderPresent.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  kbd?: string;
  side?: "top" | "bottom";
  open?: boolean;
  children: ReactElement;
}

export function Tooltip({ content, kbd, side = "top", open, children }: TooltipProps) {
  const providerPresent = useContext(ProviderPresent);
  const tooltip = (
    <Primitive.Root open={open} delayDuration={350}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className="z-(--z-tooltip) flex animate-[em-tooltip_var(--dur-1)_var(--ease-out)] items-center gap-1.5 whitespace-nowrap rounded-sm bg-inverse px-2 py-1 font-sans text-12 font-normal leading-(--lh-snug) text-fg-inverse data-[side=bottom]:[--tooltip-offset:-2px]"
        >
          {content}
          {kbd && (
            <Kbd className="border-[oklch(from_var(--n-500)_0.6_c_h_/_0.5)] bg-transparent text-inherit">{kbd}</Kbd>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
  return providerPresent ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
