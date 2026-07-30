import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="alert" className={cn("relative w-full rounded-lg border border-blue-900/70 bg-blue-950/30 p-4 text-sm text-blue-100", className)} {...props} />;
}
