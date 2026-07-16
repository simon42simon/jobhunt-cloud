import * as React from "react";
import { type VariantProps } from "class-variance-authority";
declare const badgeVariants: (props?: ({
    variant?: "default" | "destructive" | "outline" | "secondary" | "success" | "warning" | "info" | "tone" | null | undefined;
} & import("class-variance-authority/types").ClassProp) | undefined) => string;
export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
    /**
     * Runtime CSS color (any hue). When set, the badge renders as same-hue
     * translucent-tint text: `color` = the value and `background` = a ~14% tint
     * of that same color (`color-mix(in srgb, currentColor 14%, transparent)`),
     * overriding `variant`. One recipe covers any hue, so a status/track/fit
     * color map can drive it directly. Provide an AA-safe color (see the fleet's
     * statusColors vetting) - the component does not vet contrast.
     */
    tone?: string;
}
declare function Badge({ className, variant, tone, style, ...props }: BadgeProps): React.JSX.Element;
export { Badge, badgeVariants };
