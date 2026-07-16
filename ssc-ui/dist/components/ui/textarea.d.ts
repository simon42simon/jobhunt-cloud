import * as React from "react";
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    /**
     * Grow the field to fit its content instead of scrolling. The textarea starts
     * at `rows` and expands as the user types (min-height still honors `rows`).
     * Height is driven off scrollHeight on input and on controlled `value`
     * changes. Leave off for a fixed, user-resizable box.
     */
    autoResize?: boolean;
}
/**
 * Textarea - multi-line input mirroring Input's token styling and focus ring
 * (border-input, bg-transparent, ring-ring). Field/Label-composable: Field
 * clones it to wire `id`, `aria-describedby`, and `aria-invalid`, so an error
 * state comes for free. Defaults to a sensible 3 rows.
 */
declare const Textarea: React.ForwardRefExoticComponent<TextareaProps & React.RefAttributes<HTMLTextAreaElement>>;
export { Textarea };
