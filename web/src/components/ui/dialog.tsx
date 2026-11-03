import { Dialog as DialogPrimitive, Direction } from 'radix-ui';
import * as React from 'react';

import { resolvePortalTarget, usePortalScope } from '@/app/idpn-root';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /**
   * Optional override. Inside `IdpnRoot` the overlay always targets the scoped portal host,
   * so MFE code should leave this unset.
   */
  container?: HTMLElement | null;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, container, ...props }, ref) => {
  const scope = usePortalScope();
  const direction = Direction.useDirection();
  const target = resolvePortalTarget(container, scope, 'DialogContent');

  // The root portal host is attached between commit and the following render. Rendering
  // nothing keeps an initially-open dialog out of `document.body` during that tick.
  if (target === null) {
    return null;
  }

  return (
    <DialogPrimitive.Portal container={target}>
      {/*
       * A portal leaves the DOM subtree that carries `dir` (the standalone admin surface
       * portals to `document.body`), so the direction is repeated on the overlay. Inside
       * IdpnRoot this is the same value `DirectionProvider` already supplies.
       */}
      <div dir={direction} className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Overlay className="absolute inset-0 bg-black/50" />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            'relative z-10 w-full max-w-md rounded-lg border border-border bg-background p-6 text-foreground shadow-lg',
            className,
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
});
DialogContent.displayName = 'DialogContent';

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export { Dialog, DialogClose, DialogTrigger };
