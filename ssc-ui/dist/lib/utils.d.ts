import { type ClassValue } from "clsx";
/**
 * cn - merge class names with clsx (conditional joins) then tailwind-merge
 * (dedupe conflicting Tailwind utilities, last-wins). The standard shadcn/ui
 * class helper.
 */
export declare function cn(...inputs: ClassValue[]): string;
