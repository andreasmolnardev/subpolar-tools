import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Separator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" className={cn("shrink-0 bg-blue-950/80", className)} {...props} />;
}
