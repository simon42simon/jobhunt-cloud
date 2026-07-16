import * as React from "react";
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Field label text. Rendered as a <Label> bound to the control. */
    label?: React.ReactNode;
    /** Explicit id for the control; auto-generated with useId when omitted. */
    htmlFor?: string;
    /** Helper text shown below the control (hidden while an error is present). */
    description?: React.ReactNode;
    /** Error message; sets aria-invalid on the control and text-destructive copy. */
    error?: React.ReactNode;
    /** Appends a destructive asterisk to the label. */
    required?: boolean;
}
/**
 * Field - lightweight composition wrapper: Label + control slot + optional
 * description + optional error. Dependency-free (no react-hook-form / zod).
 * When the single child is a valid element it is cloned to receive `id`,
 * `aria-describedby`, and `aria-invalid`, so labels and messages are wired for
 * assistive tech without any extra prop plumbing by the consumer.
 */
declare const Field: React.ForwardRefExoticComponent<FieldProps & React.RefAttributes<HTMLDivElement>>;
export { Field };
