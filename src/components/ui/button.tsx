// Adapted from shadcn/ui's vendored Button primitive (MIT). WebAI keeps the
// component local and maps its variants directly to the project's semantic CSS.
import { forwardRef, type ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", type = "button", ...props }, ref) => {
    const classes = [`button-${variant}`, className].filter(Boolean).join(" ");
    return <button ref={ref} type={type} className={classes} data-slot="button" {...props} />;
  },
);

Button.displayName = "Button";

export default Button;
