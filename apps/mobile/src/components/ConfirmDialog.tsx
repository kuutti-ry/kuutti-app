import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The question before a change that cannot be taken back: what it does, a way
 * out, and the change itself in the destructive colour, whose words carry the
 * meaning while the colour only repeats it. Closing it any other way is the
 * way out.
 */
export function ConfirmDialog({
  open,
  closeLabel,
  title,
  body,
  cancel,
  confirm,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  closeLabel: string;
  title: string;
  body?: string;
  cancel: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent closeLabel={closeLabel}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body !== undefined && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onPress={onCancel}>
            {cancel}
          </Button>
          <Button variant="destructive" onPress={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
